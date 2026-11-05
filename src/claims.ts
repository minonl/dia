// dia claims —— 共享热点文件的 advisory claim（M1a）
//
// 设计：docs/msg-collab-m1-design.md §1
// 事实源：~/.dia/collab/claims.jsonl（append-only）；不阻断、不排队，只让“谁在改”可见。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import * as paths from "./paths.ts";
import { resolveSessionId, withLock } from "./collab.ts";

export interface Claim {
  id: string;
  path: string;
  scope: string;
  holder: string;
  reason?: string;
  created_at: string;
  expires_at: string;
  released_at?: string;
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
  const abs = resolve(root, input);
  const base = resolve(root);
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

export interface ClaimResult { claim: Claim; overlaps: Claim[] }

export function claim(input: string, opts: { reason?: string; ttl?: string; session?: string; cwd?: string; now?: Date } = {}): ClaimResult {
  const holder = resolveSessionId(opts.session);
  const { scope, root } = scopeFor(opts.cwd);
  const path = normalizePath(input, root);
  const now = opts.now || new Date();
  const expires = new Date(now.getTime() + parseTtl(opts.ttl)).toISOString();
  const id = `c-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
  const claim: Claim = { id, path, scope, holder, reason: opts.reason, created_at: now.toISOString(), expires_at: expires };
  return withLock("claims", () => {
    const overlaps = fold().filter((c) => isActive(c, now.getTime()) && c.scope === scope && c.path === path && c.holder !== holder);
    append({ event: "claim", id, path, scope, holder, reason: opts.reason, created_at: claim.created_at, expires_at: expires });
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
