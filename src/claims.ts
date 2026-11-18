// dia claims —— 共享热点文件的 advisory claim（M1a）
//
// 设计：docs/msg-collab-m1-design.md §1
// 事实源：~/.dia/collab/claims.jsonl（append-only）；不阻断、不排队，只让“谁在改”可见。
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import * as paths from "./paths.ts";
import { resolveSessionId, withLock } from "./collab.ts";

export type ClaimLease = "exclusive" | "shared";

export interface Claim {
  id: string;
  path: string;
  scope: string;
  holder: string;
  reason?: string;
  created_at: string;
  expires_at: string;
  released_at?: string;
  /** workbench track 引用（M2 additive；旧记录无此字段） */
  track?: string;
  /** 租约类型（M2 additive；旧记录无此字段 = 无租约语义，保持旧行为） */
  lease?: ClaimLease;
  /** 工作树绝对路径的 8 位 sha1（M2 additive；缺省 = 沿用旧的 scope+path 键） */
  worktree?: string;
}

interface ClaimEvent {
  ts: string;
  event: "claim" | "release";
  id: string;
  path?: string;
  scope?: string;
  holder?: string;
  reason?: string;
  created_at?: string;
  expires_at?: string;
  track?: string;
  lease?: ClaimLease;
  worktree?: string;
}

const file = () => join(paths.diaHome(), "collab", "claims.jsonl");

function append(e: Omit<ClaimEvent, "ts">): void {
  const dir = join(paths.diaHome(), "collab");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(file(), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
}

function fold(): Claim[] {
  if (!existsSync(file())) return [];
  const map = new Map<string, Claim>();
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: ClaimEvent; try { e = JSON.parse(line); } catch { continue; }
    if (!e.id) continue;
    if (e.event === "claim" && e.path && e.scope && e.holder) {
      map.set(e.id, {
        id: e.id,
        path: e.path,
        scope: e.scope,
        holder: e.holder,
        reason: e.reason,
        created_at: e.created_at || e.ts,
        expires_at: e.expires_at || e.ts,
        track: e.track,
        lease: e.lease === "exclusive" || e.lease === "shared" ? e.lease : undefined,
        worktree: e.worktree,
      });
    } else if (e.event === "release") {
      const c = map.get(e.id);
      if (c) c.released_at = e.ts;
    }
  }
  return [...map.values()];
}

export function isActive(c: Claim, now = Date.now()): boolean {
  return !c.released_at && new Date(c.expires_at).getTime() > now;
}

/** 从当前目录推导 git 根与 scope 标签（不把绝对路径写进 JSONL）。 */
export function scopeFor(cwd = process.cwd()): { scope: string; root: string } {
  let root = cwd;
  try { root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd; } catch { /* not git */ }
  let slug = `local:${basename(root)}`;
  try {
    const url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) slug = m[1].replace(/\.git$/, "");
  } catch { /* no remote */ }
  return { scope: slug, root };
}

/** 路径规范化：相对 git 根、拒绝越界；返回 POSIX 分隔符。 */
export function normalizePath(input: string, root = process.cwd()): string {
  const lexicalRoot = resolve(root);
  let base = lexicalRoot;
  // macOS 的 /var → /private/var 等符号链接会让「同一路径」字符串前缀比较失败（实测 wt create --track）
  try { base = realpathSync(base); } catch { /* 根尚不存在，保留字面值 */ }
  const raw = resolve(lexicalRoot, input);
  const relFromRoot = relative(lexicalRoot, raw);
  // 落在根内 → 映射到真实根后再 realpath；落在根外 → 保持原值，交给越界判定
  let abs = relFromRoot.startsWith("..") || relFromRoot.includes(`..${sep}`) ? raw : resolve(base, relFromRoot);
  try { abs = realpathSync(abs); } catch { /* 文件尚不存在，保留映射后的字面值 */ }
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`E_CLAIM_PATH: 越出 scope: ${input}`);
  const rel = relative(base, abs) || ".";
  return rel.split(sep).join("/");
}

export function parseTtl(raw?: string): number {
  const s = String(raw || "4h").trim();
  const m = s.match(/^(\d+)([smhd])?$/);
  if (!m) throw new Error(`E_USAGE: --ttl 格式示例 30m / 4h / 1d`);
  const n = Number(m[1]);
  const mult = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : m[2] === "s" ? 1000 : 1000;
  return n * mult;
}

/** 工作树标识：绝对路径的 8 位 sha1（§6.2 键的第二段）。 */
export function worktreeKey(input: string): string {
  return createHash("sha1").update(resolve(input)).digest("hex").slice(0, 8);
}

export interface ClaimResult { claim: Claim; overlaps: Claim[] }

export interface ClaimOptions {
  reason?: string;
  ttl?: string;
  session?: string;
  cwd?: string;
  now?: Date;
  /** M2：挂到 workbench track（只记录，不参与键） */
  track?: string;
  /** M2：租约类型；缺省 = 旧语义（不阻断，只报 overlap） */
  lease?: ClaimLease;
  /** M2：工作树绝对路径；给了就把键升级为 (scope, worktree, path) */
  worktree?: string;
}

export function claim(input: string, opts: ClaimOptions = {}): ClaimResult {
  const lease = opts.lease;
  if (lease !== undefined && lease !== "exclusive" && lease !== "shared") {
    throw new Error(`E_USAGE: --lease 只能是 exclusive 或 shared（收到 ${String(lease)}）`);
  }
  if (lease === "shared" && !opts.reason) throw new Error("E_CLAIM_LEASE: shared 需要 --reason");

  const holder = resolveSessionId(opts.session);
  // 给了 worktree 且未显式给 cwd：以 worktree 为基准推导 scope / 相对路径
  const base = opts.cwd ?? (opts.worktree ? resolve(opts.worktree) : undefined);
  const { scope, root } = scopeFor(base);
  const path = normalizePath(input, root);
  const worktree = opts.worktree ? worktreeKey(opts.worktree) : undefined;
  const now = opts.now || new Date();
  const expires = new Date(now.getTime() + parseTtl(opts.ttl)).toISOString();
  const id = `c-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
  const claim: Claim = {
    id, path, scope, holder, reason: opts.reason, created_at: now.toISOString(), expires_at: expires,
    track: opts.track, lease, worktree,
  };
  return withLock("claims", () => {
    const overlaps = fold().filter((c) =>
      isActive(c, now.getTime()) && c.scope === scope && c.worktree === worktree && c.path === path && c.holder !== holder
    );
    // exclusive：同键第二持有者直接拒（§6.2）
    if (lease === "exclusive" && overlaps.length) {
      const first = [...overlaps].sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0];
      throw new Error(`E_CLAIM_LEASE: ${first.id} 持有中（至 ${first.expires_at}）`);
    }
    append({ event: "claim", id, path, scope, holder, reason: opts.reason, created_at: claim.created_at, expires_at: expires, track: opts.track, lease, worktree });
    return { claim, overlaps };
  });
}

export function list(opts: { all?: boolean; mine?: string; cwd?: string; now?: Date } = {}): Claim[] {
  const now = (opts.now || new Date()).getTime();
  const scope = opts.cwd ? scopeFor(opts.cwd).scope : undefined;
  return fold().filter((c) => {
    if (scope && c.scope !== scope) return false;
    if (opts.mine && c.holder !== opts.mine) return false;
    return opts.all ? true : isActive(c, now);
  }).sort((a, b) => a.path.localeCompare(b.path) || a.created_at.localeCompare(b.created_at));
}

export function unclaim(target: string, opts: { session?: string; force?: boolean; cwd?: string } = {}): Claim {
  const holder = resolveSessionId(opts.session);
  const { scope, root } = scopeFor(opts.cwd);
  const path = target.startsWith("c-") ? null : normalizePath(target, root);
  return withLock("claims", () => {
    const hit = fold().find((c) => isActive(c) && c.scope === scope && (c.id === target || c.path === path));
    if (!hit) throw new Error(`E_CLAIM: 没有活跃 claim: ${target}`);
    if (hit.holder !== holder && !opts.force) throw new Error(`E_CLAIM_OWNER: ${hit.id} 属于 ${hit.holder}（--force 可强制释放）`);
    append({ event: "release", id: hit.id, holder });
    return { ...hit, released_at: new Date().toISOString() };
  });
}

export function fileOf(): string { return file(); }

/** 压缩 claims.jsonl：保留活跃 claim + 最近 N 天的 claim/release，删除更早的已过期/已释放记录。 */
export function compact(opts: { days?: number; now?: Date } = {}): { before: number; after: number; dropped: number } {
  const days = Math.max(0, Number(opts.days ?? 7));
  const now = opts.now || new Date();
  const cutoff = now.getTime() - days * 86_400_000;
  return withLock("claims", () => {
    const f = file();
    if (!existsSync(f)) return { before: 0, after: 0, dropped: 0 };
    const raw = readFileSync(f, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const keepIds = new Set<string>();
    for (const line of lines) {
      let e: ClaimEvent; try { e = JSON.parse(line); } catch { continue; }
      if (e.event !== "claim" || !e.id) continue;
      const created = new Date(e.created_at || e.ts).getTime();
      if (isActive({ id: e.id, path: e.path || "", scope: e.scope || "", holder: e.holder || "", created_at: e.created_at || e.ts, expires_at: e.expires_at || e.ts }, now.getTime()) || created > cutoff) {
        keepIds.add(e.id);
      }
    }
    const kept: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      let e: ClaimEvent; try { e = JSON.parse(line); } catch { dropped++; continue; }
      if (e.id && keepIds.has(e.id)) kept.push(line);
      else dropped++;
    }
    if (dropped) {
      const tmp = `${f}.tmp.${process.pid}`;
      writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
      renameSync(tmp, f);
    }
    const after = existsSync(f) ? readFileSync(f, "utf8").length : 0;
    return { before: raw.length, after, dropped };
  });
}
