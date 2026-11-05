import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import * as kit from "./kit.ts";
import * as defaultMsg from "./default-msg.ts";
import * as config from "./config.ts";
import * as active from "./active.ts";
import { parseJsonc, setTopLevelKey } from "./jsonc.ts";
import * as paths from "./paths.ts";

// 目录惰性解析（测试与多 persona 场景 env 会变）
const dataDir = () => paths.diaHome();
const cacheDir = () => paths.srcCacheDir();
const opencodeAgents = () => process.env.DIA_OPENCODE_AGENTS_DIR || join(homedir(), ".config", "opencode", "agents");
const dshProfiles = () => process.env.DIA_DSH_PROFILES_DIR || join(homedir(), ".dsh", "profiles");
// codex 没有「profile」概念，隔离单位是 HOME：codex 读 $CODEX_HOME/AGENTS.md（默认 $HOME/.codex），
// skills 读 $HOME/.agents/skills。所以 codex host 渲染到一个**假 HOME**（默认 <data>/codex-home），
// 由调用方把 HOME/CODEX_HOME 指过去；绝不写用户的真实 ~/.codex（否则会覆盖主 yan 身份）。
const codexHomeDir = (home?: string) => resolve(home || process.env.DIA_CODEX_HOME || join(dataDir(), "codex-home"));
// 多 persona 共享同一个全局 codex-home 会互相覆盖（rendered 哈希必然互相矛盾 ⇒ verify 恒 fail）。
// 规则：显式 --home > DIA_CODEX_HOME > persona 自己声明的 data_root（角色隔离）> 全局 codex-home（单 persona 场景）。
const expandTilde = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const codexHomeFor = (opts: { home?: string }, m: { data_root?: string }) =>
  opts.home || process.env.DIA_CODEX_HOME
    ? codexHomeDir(opts.home)
    : codexHomeDir(m.data_root ? expandTilde(m.data_root) : undefined);
const HOSTS = new Set(["opencode", "dsh", "codex"]);
const assertHost = (h: string) => { if (!HOSTS.has(h)) throw new Error("E_HOST: host not implemented: " + h); };
// opencode 的全局配置可能有 .json / .jsonc 两种文件名。顺序与宿主一致
// （packages/core/src/config/discovery.ts: names = ["opencode.json", "opencode.jsonc"]），
// 两者都存在时宿主先读 .json；只有 .jsonc 时（v1.14.49+ 新装默认）读 .jsonc。
const OPENCODE_CONFIG_NAMES = ["opencode.json", "opencode.jsonc"];
const opencodeConfigDir = () => process.env.DIA_OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
const opencodeConfigCandidates = () =>
  process.env.DIA_OPENCODE_CONFIG ? [process.env.DIA_OPENCODE_CONFIG] : OPENCODE_CONFIG_NAMES.map((n) => join(opencodeConfigDir(), n));
/** 实际生效的 opencode 配置文件：env 显式指定 > 存在的 .json > 存在的 .jsonc > 默认 .json。 */
export const opencodeConfig = (): string => {
  const candidates = opencodeConfigCandidates();
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
};

export interface Manifest {
  schema: number;
  kind: "persona" | "kit";
  id: string;
  name?: string;
  version: string;
  hosts?: string[];
  entry?: Record<string, string>;
  kits?: string[];
  // persona 可自带内容（等价于内联 kit）：路径相对 persona 根
  files?: { from: string; to: string }[];
  skills?: { from: string; name?: string; mode?: "link" | "copy"; to?: string }[];
  dirs?: string[];
  commands?: { name: string; entry: string; runtime?: "bun" | "node" | "bash"; env?: Record<string, string> }[];
  knowledge?: string[];
  data_root?: string;
  env?: { files?: string[]; keys?: string[] };
  config?: { file: string; jsonc?: boolean; set: Record<string, unknown> }[];
  capabilities?: Record<string, unknown>;
}

export interface Installed {
  id: string;
  version: string;
  dir: string;
  rendered: string[];
  hash: string;
  /** 被 --force 覆盖的已存在产物（覆盖前已备份），供 CLI 提示 */
  overwrites?: string[];
  /** 默认 msg kit 的装配结果（不阻断 persona 安装；失败原因供 doctor/CLI 显示） */
  msgKit?: { ok: boolean; reason?: string; kit?: string };
  /** 来源 commit（git 源 = rev-parse HEAD；本地目录 = --short HEAD 或 "local"；dry-run = "dry-run"）。
   *  CLI 展示与 persona check 走同一条信息，避免「undefined」。 */
  commit: string;
}

function shaFile(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  (function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(p);
    }
  })(root);
  return out.sort();
}

export function readManifest(dir: string): Manifest {
  const p = join(dir, "dia.json");
  if (!existsSync(p)) throw new Error("E_MANIFEST: dia.json not found");
  let m: Manifest;
  try { m = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error("E_MANIFEST: invalid json"); }
  if (m.schema !== 1) throw new Error("E_MANIFEST: unsupported schema");
  if (m.kind !== "persona" && m.kind !== "kit") throw new Error("E_MANIFEST: kind must be persona|kit");
  if (!m.id || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) throw new Error("E_MANIFEST: bad id");
  if (!m.version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) throw new Error("E_MANIFEST: bad version");
  return m;
}

function resolveSource(from: string, ref?: string): { dir: string; commit: string } {
  if (from.startsWith("git+") || from.startsWith("http://") || from.startsWith("https://") || from.startsWith("git@")) {
    const url = from.replace(/^git\+/, "");
    const key = createHash("sha1").update(url).digest("hex").slice(0, 12);
    const dir = join(cacheDir(), key);
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!existsSync(dir)) {
      mkdirSync(cacheDir(), { recursive: true });
      try {
        execFileSync("git", ["clone", "--quiet", url, dir], { stdio: "pipe" });
      } catch {
        rmSync(dir, { recursive: true, force: true });
        throw new Error("E_SOURCE: git clone failed (check URL/credentials)");
      }
    }
    try {
      git(["fetch", "--quiet", "origin"]);
      if (ref) {
        git(["fetch", "--quiet", "origin", ref]);
        git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      } else {
        try { git(["checkout", "--quiet", "--detach", "origin/HEAD"]); } catch {}
      }
    } catch {
      throw new Error("E_SOURCE: git ref not found");
    }
    const commit = git(["rev-parse", "HEAD"]).trim();
    return { dir, commit };
  }
  const dir = resolve(from);
  if (!existsSync(dir)) throw new Error("E_SOURCE: path not found");
  let commit = "local";
  try { commit = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  return { dir, commit };
}

/** 版本槽位：semver + git 短 sha（内容寻址）；无 semver 时只留 sha。同 semver 不同 commit 不覆盖。 */
function slotOf(version: string | undefined, commit: string): string {
  const g = commit && commit !== "local" ? `g${commit.slice(0, 12)}` : "local";
  return version ? `${version}+${g}` : g;
}

function hashTree(root: string): string {
  const h = createHash("sha256");
  for (const f of walkFiles(root)) {
    h.update(relative(root, f)).update("\0").update(shaFile(f)).update("\n");
  }
  return h.digest("hex");
}

export function install(from: string, opts: { ref?: string; host?: string; home?: string; dryRun?: boolean; force?: boolean } = {}): Installed {
  const src = resolveSource(from, opts.ref);
  const m = readManifest(src.dir);
  if (m.kind !== "persona") throw new Error("E_MANIFEST: not a persona");
  const slot = slotOf(m.version, src.commit);
  const target = resolve(dataDir(), "personas", m.id, slot);
  if (!target.startsWith(resolve(dataDir(), "personas") + sep)) throw new Error("E_MANIFEST: version escapes install dir");
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) assertHost(h);
  const rendered: string[] = [];
  const overwrites: string[] = [];

  // 先检查宿主冲突，避免破坏已安装目录
  const entry = hosts.includes("opencode") ? m.entry?.opencode : undefined;
  if (hosts.includes("opencode")) {
    if (!entry) throw new Error("E_MANIFEST: missing entry.opencode");
    const entryAbs = resolve(src.dir, entry);
    if (!existsSync(entryAbs)) throw new Error("E_MANIFEST: entry.opencode file missing");
    if (lstatSync(entryAbs).isSymbolicLink()) throw new Error("E_MANIFEST: entry must not be a symlink");
    const srcReal = realpathSync(src.dir);
    const entryReal = realpathSync(entryAbs);
    if (!entryReal.startsWith(srcReal + sep)) throw new Error("E_MANIFEST: entry escapes persona dir");
    const dest = join(opencodeAgents(), `${m.id}.md`);
    if (existsSync(dest) && !readFileSync(dest).equals(readFileSync(entryAbs))) {
      // 手改/旧版本的产物：默认拒绝；--force 才覆盖，且覆盖前先备份（覆盖不丢东西）
      if (!opts.force) throw new Error("E_CONFLICT: agent file exists and differs; remove it first (或 --force 覆盖，覆盖前会备份)");
      overwrites.push(dest);
    }
  }

  const dshEntry = hosts.includes("dsh") ? m.entry?.dsh : undefined;
  if (hosts.includes("dsh")) {
    if (!dshEntry) throw new Error("E_MANIFEST: missing entry.dsh");
    const dshSrc = resolve(src.dir, dshEntry);
    if (!existsSync(dshSrc) || !statSync(dshSrc).isDirectory()) throw new Error("E_MANIFEST: entry.dsh dir missing");
    if (!realpathSync(dshSrc).startsWith(realpathSync(src.dir) + sep) && realpathSync(dshSrc) !== realpathSync(src.dir)) throw new Error("E_MANIFEST: entry escapes persona dir");
  }

  const codexEntry = hosts.includes("codex") ? m.entry?.codex : undefined;
  const codexHome = hosts.includes("codex") ? codexHomeFor(opts, m) : null;
  if (hosts.includes("codex")) {
    if (!codexEntry) throw new Error("E_MANIFEST: missing entry.codex");
    const abs = resolve(src.dir, codexEntry);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("E_MANIFEST: entry.codex file missing");
    if (!realpathSync(abs).startsWith(realpathSync(src.dir) + sep)) throw new Error("E_MANIFEST: entry escapes persona dir");
    const dest = join(codexHome!, ".codex", "AGENTS.md");
    if (existsSync(dest) && !readFileSync(dest).equals(readFileSync(abs))) {
      if (!opts.force) throw new Error("E_CONFLICT: codex AGENTS.md exists and differs; use --force (备份后再覆盖)");
      overwrites.push(dest);
    }
  }

  if (opts.dryRun) {
    if (hosts.includes("opencode")) rendered.push(join(opencodeAgents(), `${m.id}.md`));
    if (hosts.includes("codex")) rendered.push(join(codexHome!, ".codex", "AGENTS.md"));
    return { id: m.id, version: slot, dir: target, rendered, hash: "dry-run", commit: src.commit, overwrites };
  }

  // 原子安装：staging → 写 lock → rename；同槽位不同内容判冲突，绝不原地覆盖
  const idDir = resolve(dataDir(), "personas", m.id);
  mkdirSync(idDir, { recursive: true });
  const lockPath = join(idDir, ".lock");
  let lockFd: number | null = null;
  try {
    try { lockFd = openSync(lockPath, "wx"); }
    catch {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > 10 * 60_000) { rmSync(lockPath, { force: true }); lockFd = openSync(lockPath, "wx"); }
      else throw new Error("E_LOCKED: 另一个安装正在进行（10 分钟后视为陈旧）");
    }
    writeFileSync(lockPath, String(process.pid));
    const staging = join(idDir, `.staging-${process.pid}-${Date.now().toString(36)}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(src.dir, staging, { recursive: true, dereference: true, filter: (p: string) => !p.split(sep).includes(".git") && !p.split(sep).includes("node_modules") });
    const stagingHash = hashTree(staging);
    let reuseTarget = false;
    if (existsSync(target)) {
      const existing = (() => { try { return JSON.parse(readFileSync(join(target, "dia.lock"), "utf8")); } catch { return null; } })();
      if (existing && existing.hash === stagingHash) {
        // 幂等：同槽位同内容 → 不重装版本，但仍要跑一遍宿主渲染（--force 时恢复被手改的产物）
        rmSync(staging, { recursive: true, force: true });
        reuseTarget = true;
      } else if (!opts.force) {
        rmSync(staging, { recursive: true, force: true });
        throw new Error(`E_VERSION_COLLISION: ${m.id}@${slot} 已存在且内容不同（换 commit/ref 会得到新槽位）`);
      } else {
        rmSync(target, { recursive: true, force: true });
      }
    }
    if (!reuseTarget) renameSync(staging, target);
  } finally {
    if (lockFd !== null) { try { closeSync(lockFd); } catch {} }
    try { rmSync(lockPath, { force: true }); } catch {}
  }

  if (hosts.includes("opencode")) {
    mkdirSync(opencodeAgents(), { recursive: true });
    const dest = join(opencodeAgents(), `${m.id}.md`);
    if (overwrites.length) {
      // 覆盖前先备份（--force 的代价必须可回滚）
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bdir = join(dataDir(), "backups", `persona-${m.id}-${stamp}`);
      mkdirSync(bdir, { recursive: true });
      for (const p of overwrites) cpSync(p, join(bdir, basename(p)));
    }
    const entryAbs2 = resolve(target, entry!);
    if (!entryAbs2.startsWith(resolve(target) + sep)) throw new Error("E_MANIFEST: entry escapes persona dir");
    cpSync(entryAbs2, dest);
    rendered.push(dest);
  }

  const renderedDirs: { path: string; hash: string }[] = [];
  if (hosts.includes("dsh")) {
    const dshDest = resolve(dshProfiles(), m.id);
    if (existsSync(dshDest) && !existsSync(join(dshDest, ".dia-managed"))) {
      throw new Error("E_CONFLICT: dsh profile exists and is not managed by dia");
    }
    rmSync(dshDest, { recursive: true, force: true });
    mkdirSync(dshDest, { recursive: true });
    cpSync(resolve(target, dshEntry!), dshDest, { recursive: true });
    writeFileSync(join(dshDest, ".dia-managed"), JSON.stringify({ id: m.id, version: m.version }, null, 1));
    // hash 只是安装时快照（诊断用）；校验不比对它——宿主会重写自己 profile 里的文件。
    renderedDirs.push({ path: dshDest, hash: hashTree(dshDest) });
  }

  const codexLinks: any[] = [];
  if (hosts.includes("codex")) {
    const ch = codexHome!;
    // codex 读 $CODEX_HOME/AGENTS.md；isolated home 下即 <home>/.codex/AGENTS.md
    mkdirSync(join(ch, ".codex"), { recursive: true });
    const dest = join(ch, ".codex", "AGENTS.md");
    cpSync(resolve(target, codexEntry!), dest);
    rendered.push(dest);
    // skills：codex USER 级读 $HOME/.agents/skills（与 $CODEX_HOME 无关）→ 落到假 HOME 下
    const skillRoot = join(ch, ".agents", "skills");
    for (const sk of m.skills ?? []) {
      const srcSkill = resolve(target, sk.from);
      if (!srcSkill.startsWith(target + sep)) throw new Error("E_MANIFEST: skill escapes persona dir: " + sk.from);
      if (!existsSync(srcSkill)) continue;
      const name = sk.name || basename(srcSkill);
      mkdirSync(skillRoot, { recursive: true });
      const link = join(skillRoot, name);
      rmSync(link, { recursive: true, force: true });
      if ((sk.mode ?? "link") === "copy") cpSync(srcSkill, link, { recursive: true });
      else {
        symlinkSync(srcSkill, link, "dir");
        codexLinks.push({ type: "link", path: link, value: relative(target, srcSkill) });
      }
    }
  }

  // persona 自带内容（内联 kit 语义）：baseDir = target，链接指向 persona 树自身
  // codex-only persona 的 skills 由下面的 codex 分支落到假 HOME；不要同时链到真实 ~/.agents/skills
  const inlineManifest = hosts.some((h) => h === "opencode" || h === "dsh") ? m : { ...m, skills: [] };
  const inline = [...(kit.renderContent(target, target, inlineManifest) ?? []), ...codexLinks];
  const appliedConfig = config.apply((m.config ?? []) as any);

  // kits：包内相对路径，装完树后逐个分发（内容归 kit，人格只引用）
  const kitRefs: { id: string; version: string }[] = [];
  for (const ref of m.kits ?? []) {
    const kitDir = resolve(target, ref);
    if (!kitDir.startsWith(target + sep)) throw new Error(`E_MANIFEST: kit escapes persona dir: ${ref}`);
    if (!existsSync(join(kitDir, "dia.json"))) throw new Error(`E_MANIFEST: kit manifest missing: ${ref}`);
    const r = kit.install(kitDir);
    kitRefs.push({ id: r.id, version: r.version });
  }

  // 默认能力包（dia-msg）：不阻断 persona 安装；显式 capabilities.msg=false 或用户 disable 时跳过。
  const msgKit = defaultMsg.ensureForPersona(m.id, m.capabilities);

  const hash = hashTree(target);
  const renderedHashes: Record<string, string> = {};
  for (const f of rendered) renderedHashes[f] = shaFile(f);
  writeFileSync(join(target, "dia.lock"), JSON.stringify({ id: m.id, version: m.version, slot, commit: src.commit, source: from, ref: opts.ref ?? null, hash, rendered, renderedHashes, renderedDirs, kits: kitRefs,
    content: { knowledge: m.knowledge ?? [], commands: m.commands ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null, rendered: inline, config: appliedConfig },
  }, null, 1));
  return { id: m.id, version: slot, dir: target, rendered, hash, commit: src.commit, overwrites, msgKit };
}

export function list(): { id: string; versions: string[] }[] {
  const root = join(dataDir(), "personas");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, versions: versionDirs(join(root, e.name)) }));
}

/** 版本目录：新布局 versions/<vid>；旧平铺布局兜底；跳过软链与保留名 */
export function versionDirs(idDir: string): string[] {
  const verRoot = join(idDir, "versions");
  const scan = (root: string, keep: (n: string) => boolean) =>
    existsSync(root)
      ? readdirSync(root).filter((n) => {
          if (!keep(n)) return false;
          try { return lstatSync(join(root, n)).isDirectory(); } catch { return false; }
        }).sort()
      : [];
  if (existsSync(verRoot)) return scan(verRoot, () => true);
  const keep = (n: string) => !["current", "latest", "data", "repo", "repo.git", "worktrees", "versions"].includes(n) && !n.startsWith(".staging-") && n !== ".lock";
  return scan(idDir, keep);
}

/** 选择器解析：精确 → 唯一前缀（0.1.0 → 0.1.0+g<sha>）；多义报错，不猜 */
export function resolveVersion(id: string, sel: string): string {
  const dir = join(dataDir(), "personas", id);
  const all = versionDirs(dir);
  if (all.includes(sel)) return sel;
  const hits = all.filter((v) => v === sel || v.startsWith(sel + "+") || v.startsWith(sel + "-"));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`E_VERSION_AMBIGUOUS: ${id}@${sel} 命中 ${hits.join(", ")}`);
  throw new Error(`E_VERSION: ${id}@${sel} 未安装`);
}

/**
 * 版本目录解析（`dia persona path` 的唯一实现）。
 * version 缺省 ⇒ **生效版本**（active 指针，无指针回退最新安装）——与 scope.current 同口径，
 * 供服务入口 / 脚本取「当前生效的 persona 快照目录」，别让消费方自己拼 personas/<id>/<ver>。
 */
export function dirOf(id: string, version?: string): { dir: string; version: string } | null {
  const v = version || active.effective(id)?.version;
  if (!v) return null;
  const flat = join(dataDir(), "personas", id, v);
  const nested = join(dataDir(), "personas", id, "versions", v);
  const dir = existsSync(nested) ? nested : flat;
  return existsSync(dir) ? { dir, version: v } : null;
}

export interface VerifyResult {
  ok: boolean;
  dir: string;
  expected: string;
  actual: string;
  /** 具体不一致项（空数组 = 全绿）。doctor / CLI 用它给出可读原因。 */
  issues: string[];
}

/** 读取 `.dia-managed` 所有权标记（宿主 profile 目录）。 */
function readMarker(dir: string): { id?: string; version?: string } | null {
  const p = join(dir, ".dia-managed");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** semver 比较（忽略 build metadata；prerelease < release） */
function cmpSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("+")[0].split("-", 2);
    return { nums: core.split(".").map(Number), pre: pre ?? null };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = A.nums[i] || 0, y = B.nums[i] || 0;
    if (x !== y) return x - y;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) return A.pre.localeCompare(B.pre);
  return 0;
}

/** GC：保留 active + 最近 N 个（semver 排序），其余删除；dryRun 只报不删 */
export function gc(id: string, opts: { keep?: number; dryRun?: boolean; force?: boolean } = {}): { kept: string[]; removed: string[]; skipped: string[] } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const all = versionDirs(idDir);
  const activeVer = active.effective(id)?.version;
  const keep = Math.max(1, opts.keep ?? 3);
  const sorted = [...all].sort((a, b) => cmpSemver(b, a));
  const keepSet = new Set<string>(sorted.slice(0, keep));
  if (activeVer) keepSet.add(activeVer);
  const kept: string[] = [], removed: string[] = [], skipped: string[] = [];
  for (const v of all) {
    if (keepSet.has(v)) { kept.push(v); continue; }
    if (opts.dryRun) { removed.push(v); continue; }
    rmSync(join(idDir, v), { recursive: true, force: true });
    removed.push(v);
  }
  return { kept, removed, skipped };
}

export function verify(id: string, version?: string): VerifyResult {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const v = version || active.effective(id)?.version || versionDirs(idDir).sort((a, b) => cmpSemver(b, a))[0];
  if (!v) throw new Error("E_NOT_INSTALLED");
  const dir = existsSync(join(idDir, "versions", v)) ? join(idDir, "versions", v) : join(idDir, v);
  const lock = JSON.parse(readFileSync(join(dir, "dia.lock"), "utf8"));
  // lock 自身不参与内容哈希
  const files = walkFiles(dir).filter((f) => basename(f) !== "dia.lock");
  const h = createHash("sha256");
  for (const f of files) h.update(relative(dir, f)).update("\0").update(shaFile(f)).update("\n");
  const real = h.digest("hex");
  const issues: string[] = [];

  if (real !== lock.hash) issues.push(`内容哈希不一致（期望 ${lock.hash.slice(0, 8)} 实得 ${real.slice(0, 8)}）`);

  // 逐字节校验只覆盖「dia 写入、宿主不改写」的产物（如 opencode agent md）。
  for (const [f, expectedHash] of Object.entries(lock.renderedHashes || {})) {
    if (!existsSync(f)) issues.push(`产物缺失：${f}`);
    else if (shaFile(f) !== expectedHash) issues.push(`产物被改动：${f}`);
  }

  // 宿主自管的 profile 目录（dsh 会在启动时重写 cordis.yml、装插件时改 package.json）：
  // 只校验「目录还在 + .dia-managed 标记仍归本 persona」，不做字节比对——那是宿主的领地。
  for (const d of lock.renderedDirs || []) {
    if (!existsSync(d.path)) { issues.push(`宿主 profile 缺失：${d.path}`); continue; }
    const m = readMarker(d.path);
    if (!m) issues.push(`宿主 profile 缺所有权标记：${d.path}`);
    else if (m.id !== id) issues.push(`宿主 profile 归属不符（${m.id ?? "?"}）：${d.path}`);
  }

  // persona 自带内容的产物（files 复制 / skills 软链）也要校验
  for (const r of lock.content?.rendered ?? []) {
    if (r.type === "dir") continue;
    if (!existsSync(r.path)) { issues.push(`内容产物缺失：${r.path}`); continue; }
    if (r.type === "file") {
      if (shaFile(r.path) !== r.value) issues.push(`内容产物被改动：${r.path}`);
    } else {
      let cur = "";
      try { cur = realpathSync(r.path); } catch { issues.push(`内容产物不可读：${r.path}`); continue; }
      const want = resolve(dir, r.value);
      if (!existsSync(want) || cur !== realpathSync(want)) issues.push(`内容产物指向不符：${r.path}`);
    }
  }
  return { ok: issues.length === 0, dir, expected: lock.hash, actual: real, issues };
}

// ---- 作者轴：create（生成骨架） / render（不换内容重渲染） ----

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface CreateResult { id: string; dir: string; files: string[]; dryRun: boolean }

function skeleton(id: string, hosts: string[], msg = true): Record<string, string> {
  const manifest: any = {
    schema: 1, kind: "persona", id, name: id, version: "0.1.0",
    hosts,
    entry: {},
    capabilities: { tools: ["bash", "git"], network: false, env: [], msg },
    requires: { dia: ">=0.0.1" },
  };
  const files: Record<string, string> = {};
  if (hosts.includes("opencode")) {
    manifest.entry.opencode = `agents/${id}.md`;
    files[`agents/${id}.md`] = `---
description: ${id}（一句话说明它是谁、服务谁）
mode: primary
---
你是 **${id}**。

## 身份

- 服务谁：
- 边界（不做什么）：

## 工作原则

1. 先证据后结论：没验证就别说"应该没问题"。
2. 动手前说清选项与代价。
`;
  }
  if (hosts.includes("codex")) {
    manifest.entry.codex = "AGENTS.md";
    files["AGENTS.md"] = `# ${id}

你是 **${id}**。

## 身份

- 服务谁：
- 边界（不做什么）：

## 工作原则

1. 先证据后结论：没验证就别说"应该没问题"。
2. 动手前说清选项与代价。
`;
  }
  if (hosts.includes("dsh")) {
    const dir = `platform/dsh/${id}-persona`;
    manifest.entry.dsh = dir;
    files[`${dir}/cordis.yml`] = "[]\n";
    files[`${dir}/package.json`] = JSON.stringify({
      name: `dsh-${id}-persona`, private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    }, null, 2) + "\n";
    // 注意：插件 insert 必须带齐必填 config（dsh 不补默认值）；webserver 若覆盖，host/port 必须同时写。
    files[`${dir}/cordis.patch.yml`] = `# ${id} 的 dsh 覆盖层。patch 是「整体替换 config」，不是深合并——
# 覆盖某个插件时要把它的必填项一起写上（下例：tool-fs-search 的 sampleOverCapGlobResults）。
- insert:
    - id: preset-${id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${id}
        name: ${id}
        description: TODO 一句话说明
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                你是 ${id}。（在这里写人格 / 协议 / 边界）
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
# 需要独立端口时取消下面注释（host 和 port 必须同时写，否则 dsh 启动报 $.host missing）：
# - id: webserver
#   config:
#     host: !!js ctx.webStartup.host ?? '127.0.0.1'
#     port: !!js ctx.webStartup.port ?? 3100
`;
  }
  files["dia.json"] = JSON.stringify(manifest, null, 2) + "\n";
  return files;
}

/** 生成一个新 persona 的骨架（本地、不联网、不执行脚本）。 */
export function create(id: string, opts: { dir?: string; hosts?: string[]; dryRun?: boolean; msg?: boolean } = {}): CreateResult {
  if (!ID_RE.test(id)) throw new Error("E_MANIFEST: bad id（小写字母/数字/中划线）");
  if (!opts.dir) throw new Error("E_USAGE: --dir required");
  const dir = resolve(opts.dir);
  const hosts = opts.hosts?.length ? opts.hosts : ["opencode", "dsh"];
  for (const h of hosts) assertHost(h);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`E_CONFLICT: ${dir} 非空`);
  const files = skeleton(id, hosts, opts.msg !== false);
  if (!opts.dryRun) {
    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
  }
  return { id, dir, files: Object.keys(files), dryRun: !!opts.dryRun };
}

export interface RenderDrift { path: string; action: "missing" | "changed" }
export interface RenderResult { id: string; version: string; check: boolean; drift: RenderDrift[]; backups: string[]; msgKit?: { ok: boolean; reason?: string; kit?: string } }

// 宿主会在自己的 profile 目录里改写/生成这些文件（dsh 每次启动重写 cordis.yml，
// `dsh plugin --profile <id> add <pkg>` 会改 package.json 与锁文件），它们不属于渲染产物：
// 比对时跳过、写回时不覆盖，否则 --check 永远报 drift，且 re-render 会回退宿主运行态。
// 与 docs/persona-install.md §5.3 一致：profile 目录是宿主领地，dia 只关心自己写的字节。
const HOST_OWNED_FILES = new Set([
  "cordis.yml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function compareDir(expected: string, actual: string): RenderDrift[] {
  const out: RenderDrift[] = [];
  for (const f of walkFiles(expected)) {
    const rel = relative(expected, f);
    if (HOST_OWNED_FILES.has(rel)) continue;
    const dest = join(actual, rel);
    if (!existsSync(dest)) out.push({ path: dest, action: "missing" });
    else if (shaFile(dest) !== shaFile(f)) out.push({ path: dest, action: "changed" });
  }
  return out;
}

/**
 * 用**已安装版本**重渲染到宿主（不换内容）。`check` 只报 drift、不写盘。
 * 覆盖策略：被手改/丢失的产物先备份到 `<data>/backups/render-<ts>/`，再写回。
 */
export function render(id: string, opts: { host?: string; home?: string; check?: boolean } = {}): RenderResult {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error(`E_NOT_INSTALLED: persona ${id}`);
  const version = active.effective(id)?.version ?? readdirSync(idDir).filter((v) => statSync(join(idDir, v)).isDirectory()).sort().pop()!;
  const dir = join(idDir, version);
  const m = readManifest(dir);
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) assertHost(h);

  const drift: RenderDrift[] = [];
  let agentSrc: string | null = null, agentDest: string | null = null;
  let dshSrc: string | null = null, dshDest: string | null = null;
  let codexSrc: string | null = null, codexDest: string | null = null;

  if (hosts.includes("opencode")) {
    const entry = m.entry?.opencode;
    if (!entry) throw new Error("E_MANIFEST: missing entry.opencode");
    agentSrc = resolve(dir, entry);
    if (!agentSrc.startsWith(dir + sep)) throw new Error("E_MANIFEST: entry escapes persona dir");
    if (!existsSync(agentSrc)) throw new Error("E_MANIFEST: entry.opencode file missing");
    agentDest = join(opencodeAgents(), `${id}.md`);
    if (!existsSync(agentDest)) drift.push({ path: agentDest, action: "missing" });
    else if (shaFile(agentDest) !== shaFile(agentSrc)) drift.push({ path: agentDest, action: "changed" });
  }
  if (hosts.includes("codex")) {
    const entry = m.entry?.codex;
    if (!entry) throw new Error("E_MANIFEST: missing entry.codex");
    codexSrc = resolve(dir, entry);
    if (!codexSrc.startsWith(dir + sep)) throw new Error("E_MANIFEST: entry escapes persona dir");
    if (!existsSync(codexSrc)) throw new Error("E_MANIFEST: entry.codex file missing");
    codexDest = join(codexHomeFor(opts, m), ".codex", "AGENTS.md");
    if (!existsSync(codexDest)) drift.push({ path: codexDest, action: "missing" });
    else if (shaFile(codexDest) !== shaFile(codexSrc)) drift.push({ path: codexDest, action: "changed" });
  }
  if (hosts.includes("dsh")) {
    const entry = m.entry?.dsh;
    if (!entry) throw new Error("E_MANIFEST: missing entry.dsh");
    dshSrc = resolve(dir, entry);
    if (!dshSrc.startsWith(dir + sep)) throw new Error("E_MANIFEST: entry escapes persona dir");
    if (!existsSync(dshSrc)) throw new Error("E_MANIFEST: entry.dsh dir missing");
    dshDest = resolve(dshProfiles(), id);
    if (!existsSync(dshDest)) drift.push({ path: dshDest, action: "missing" });
    else {
      drift.push(...compareDir(dshSrc, dshDest));
      const marker = join(dshDest, ".dia-managed");
      if (!existsSync(marker)) drift.push({ path: marker, action: "missing" });
      else {
        try { if (JSON.parse(readFileSync(marker, "utf8")).id !== id) drift.push({ path: marker, action: "changed" }); }
        catch { drift.push({ path: marker, action: "changed" }); }
      }
    }
  }
  if (opts.check) return { id, version, check: true, drift, backups: [] };

  const msgKit = defaultMsg.ensureForPersona(id, m.capabilities);
  const backups: string[] = [];
  if (drift.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bdir = join(dataDir(), "backups", `render-${stamp}`);
    for (const d of drift) {
      if (!existsSync(d.path)) continue;
      mkdirSync(bdir, { recursive: true });
      const dest = join(bdir, basename(d.path));
      cpSync(d.path, dest, { recursive: true });
      backups.push(dest);
    }
  }
  if (agentDest && agentSrc) { mkdirSync(dirname(agentDest), { recursive: true }); cpSync(agentSrc, agentDest); }
  if (codexDest && codexSrc) { mkdirSync(dirname(codexDest), { recursive: true }); cpSync(codexSrc, codexDest); }
  if (dshDest && dshSrc) {
    // 只覆盖 persona 自己写入的文件，绝不整树重建：profile 目录是宿主领地，
    // 宿主装的插件目录/改动过的 package.json 不在 drift 名单里，删掉就再也回不来。
    mkdirSync(dshDest, { recursive: true });
    for (const f of walkFiles(dshSrc)) {
      const rel = relative(dshSrc, f);
      if (HOST_OWNED_FILES.has(rel)) continue;
      const dest = join(dshDest, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(f, dest);
    }
    writeFileSync(join(dshDest, ".dia-managed"), JSON.stringify({ id, version }, null, 1));
  }

  // 只更新渲染产物记录；persona 内容哈希（lock.hash）不变。
  const lockPath = join(dir, "dia.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  // 换 codex home 后，旧渲染路径要**剪掉**（否则 lock 里留着已不存在的路径 ⇒ verify 恒 missing）
  const staleCodex = codexDest
    ? (lock.rendered ?? []).filter((p: string) => p.endsWith("/.codex/AGENTS.md") && p !== codexDest)
    : [];
  const rendered: string[] = [...new Set([
    ...(lock.rendered ?? []).filter((p: string) => !staleCodex.includes(p)),
    ...(agentDest ? [agentDest] : []),
    ...(codexDest ? [codexDest] : []),
  ])];
  const renderedHashes: Record<string, string> = { ...(lock.renderedHashes ?? {}) };
  for (const p of staleCodex) delete renderedHashes[p];
  if (agentDest) renderedHashes[agentDest] = shaFile(agentDest);
  if (codexDest) renderedHashes[codexDest] = shaFile(codexDest);
  const renderedDirs = [...(lock.renderedDirs ?? []).filter((d: any) => d.path !== dshDest)];
  if (dshDest) renderedDirs.push({ path: dshDest, hash: hashTree(dshDest) });
  writeFileSync(lockPath, JSON.stringify({ ...lock, rendered, renderedHashes, renderedDirs }, null, 1));
  return { id, version, check: false, drift, backups, msgKit };
}

export interface RenderDriftReport {
  id: string;
  version: string;
  drift: RenderDrift[];
  /** 比对范围被裁剪的原因（无 lock / lock 损坏）：doctor 据此降级为 skip，而不是报错。 */
  skipped?: string;
}

/**
 * 渲染产物的**只读**漂移查询（doctor 用：不写盘、不备份、不改 `dia.lock`）。
 *
 * 口径与 `dia persona render <id> --check` **完全一致**（直接复用 `render({ check: true })`，
 * 共享 `HOST_OWNED_FILES` 跳过规则，避免 doctor 与 CLI 判定分叉），再按 `dia.lock` 补齐
 * 「已经渲染到宿主、但 manifest 比对看不到」的产物：
 *   · `renderedHashes`：opencode agent md 等逐字节快照；
 *   · `renderedDirs`：dsh profile 目录是否存在 + `.dia-managed` 归属标记；
 *   · `content.rendered` 的 file/link：persona 自带 `files`/`skills` 落到宿主的位置（如 `~/.config/opencode/AGENTS.md`）。
 * 这些产物都能被 `dia persona render <id>` 直接修复，所以 doctor 里按 warn 报，不与 `persona.verify` 争 fail。
 */
export function renderDrift(id: string, opts: { host?: string } = {}): RenderDriftReport {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error(`E_NOT_INSTALLED: persona ${id}`);
  const version = active.effective(id)?.version
    ?? readdirSync(idDir).filter((v) => statSync(join(idDir, v)).isDirectory()).sort().pop();
  if (!version) return { id, version: "", drift: [], skipped: `无已安装版本：${idDir}` };
  const dir = join(idDir, version);
  const lockPath = join(dir, "dia.lock");
  // 安装未完成（没有 lock）：manifest 比对也不能代表安装态 → 降级为 skip
  if (!existsSync(lockPath)) return { id, version, drift: [], skipped: `无 dia.lock（安装未完成）：${dir}` };

  let lock: any;
  try { lock = JSON.parse(readFileSync(lockPath, "utf8")); }
  catch { return { id, version, drift: [], skipped: `dia.lock 不可解析：${lockPath}` }; }

  const r = render(id, { host: opts.host, check: true });
  const drift: RenderDrift[] = [...r.drift];
  const seen = new Set(drift.map((d) => d.path));
  const push = (d: RenderDrift) => { if (!seen.has(d.path)) { seen.add(d.path); drift.push(d); } };

  // lock 里的渲染产物快照（render 写回后刷新）：手改 / 丢失都算 drift
  for (const [f, expected] of Object.entries((lock.renderedHashes ?? {}) as Record<string, string>)) {
    if (!existsSync(f)) push({ path: f, action: "missing" });
    else if (shaFile(f) !== expected) push({ path: f, action: "changed" });
  }
  // 宿主自管目录只判「还在 + 归属仍是我」，不比对字节（宿主会改写自己的文件）
  for (const d of lock.renderedDirs ?? []) {
    if (!existsSync(d.path)) { push({ path: d.path, action: "missing" }); continue; }
    const marker = join(d.path, ".dia-managed");
    if (!existsSync(marker)) { push({ path: marker, action: "missing" }); continue; }
    try { if (JSON.parse(readFileSync(marker, "utf8")).id !== id) push({ path: marker, action: "changed" }); }
    catch { push({ path: marker, action: "changed" }); }
  }
  // persona 自带内容渲染到宿主的产物（files 复制 / skills 软链）
  for (const c of lock.content?.rendered ?? []) {
    if (c.type === "dir") continue;
    if (!existsSync(c.path)) { push({ path: c.path, action: "missing" }); continue; }
    if (c.type === "file") {
      if (shaFile(c.path) !== c.value) push({ path: c.path, action: "changed" });
      continue;
    }
    let cur = "";
    try { cur = realpathSync(c.path); } catch { push({ path: c.path, action: "changed" }); continue; }
    const want = resolve(dir, c.value);
    if (!existsSync(want) || cur !== realpathSync(want)) push({ path: c.path, action: "changed" });
  }
  return { id, version: r.version, drift };
}

export function remove(id: string): { removed: string[]; skipped: string[] } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const removed: string[] = [];
  const skipped: string[] = [];
  const allowed = resolve(opencodeAgents(), `${id}.md`);
  for (const v of versionDirs(idDir)) {
    const dir = existsSync(join(idDir, "versions", v)) ? join(idDir, "versions", v) : join(idDir, v);
    const lockFile = join(dir, "dia.lock");
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, "utf8"));
      for (const d of lock.renderedDirs || []) {
        const abs = resolve(d.path);
        if (!abs.startsWith(resolve(dshProfiles()) + sep) || basename(abs) !== id) { skipped.push(abs); continue; }
        if (!existsSync(abs)) continue;
        // 宿主会改写自己目录里的文件，所以按「所有权标记」判断而不是字节哈希；
        // 标记缺失/归属不符 = 不是我们该删的东西。
        const m = readMarker(abs);
        if (!m || m.id !== id) { skipped.push(abs); continue; }
        rmSync(abs, { recursive: true, force: true }); removed.push(abs);
      }
      // 内容产物（persona 自带 files/skills）：按 lock 里记录的哈希/指向回收
      for (const r of lock.content?.rendered ?? []) {
        if (r.type === "dir") continue;
        if (!existsSync(r.path)) continue;
        if (r.type === "file") {
          if (!existsSync(r.path) || shaFile(r.path) !== r.value) { skipped.push(r.path); continue; }
          unlinkSync(r.path); removed.push(r.path);
        } else {
          let cur = "";
          try { cur = realpathSync(r.path); } catch { skipped.push(r.path); continue; }
          const want = resolve(dir, r.value);
          if (existsSync(want) && cur === realpathSync(want)) { unlinkSync(r.path); removed.push(r.path); }
          else skipped.push(r.path);
        }
      }
      // 宿主渲染（agent md / dsh profile）
      for (const f of lock.rendered || []) {
        const abs = resolve(f);
        const isCodexAgent = basename(abs) === "AGENTS.md" && basename(dirname(abs)) === ".codex";
        if (abs !== allowed && !isCodexAgent) { skipped.push(abs); continue; }
        const expectedHash = lock.renderedHashes?.[f];
        if (!expectedHash || !existsSync(abs) || shaFile(abs) !== expectedHash) { skipped.push(abs); continue; }
        rmSync(abs); removed.push(abs);
      }
      // 声明式配置：按原内容回滚（文件被改过则 skip）
      for (const r of lock.content?.config ?? []) {
        const rv = config.revert([r]);
        removed.push(...rv.restored);
        skipped.push(...rv.skipped);
      }
      // kit：随 persona 一起卸载
      for (const k of lock.kits ?? []) {
        try { kit.remove(k.id); removed.push(`kit:${k.id}@${k.version}`); } catch { skipped.push(`kit:${k.id}`); }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(idDir, { recursive: true, force: true });
  return { removed, skipped };
}


export interface DefaultAgentResult {
  file: string;
  previous: string | null;
  current: string | null;
  backup: string | null;
}

/** 读取当前默认 agent（不改文件）。支持 opencode.json / opencode.jsonc（含注释）。 */
export function showDefaultAgent(opts: { host?: string } = {}): { file: string; current: string | null } {
  const host = opts.host ?? "opencode";
  if (host !== "opencode") throw new Error("E_HOST: only opencode has default_agent");
  const file = opencodeConfig();
  if (!existsSync(file)) return { file, current: null };
  const cfg = readOpencodeConfig(file);
  return { file, current: typeof cfg.default_agent === "string" ? cfg.default_agent : null };
}

function readOpencodeConfig(file: string): any {
  const raw = readFileSync(file, "utf8");
  try { return parseJsonc(raw); }
  catch (e: any) { throw new Error(`E_CONFIG: ${file} 解析失败（JSONC）：${e?.message ?? e}`); }
}

/**
 * 把 persona 设为宿主的默认 agent（显式动作，不随 install 自动做）。
 *   · 写前备份原文件到 <data>/backups/；
 *   · 记录原值到 <data>/state/default-agent.json，供 --unset 精确还原；
 *   · 只改 default_agent 一个键，**保留 .jsonc 的注释与排版**（写回前重新解析校验）。
 */
export function setDefaultAgent(id: string | null, opts: { host?: string } = {}): DefaultAgentResult {
  const host = opts.host ?? "opencode";
  if (host !== "opencode") throw new Error("E_HOST: only opencode has default_agent");
  const file = opencodeConfig();
  if (!existsSync(file)) throw new Error(`E_CONFIG: ${file} 不存在（先装宿主，或设 DIA_OPENCODE_CONFIG）`);
  const raw = readFileSync(file, "utf8");
  const cfg = readOpencodeConfig(file);

  const stateFile = join(dataDir(), "state", "default-agent.json");
  let state: any = { file, previous: null, set_at: null };
  if (existsSync(stateFile)) { try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* 忽略坏状态 */ } }
  const previous = typeof cfg.default_agent === "string" ? cfg.default_agent : null;

  let backup: string | null = null;
  const dir = join(dataDir(), "backups");
  mkdirSync(dir, { recursive: true });
  backup = join(dir, `${basename(file)}.${Date.now()}.bak`);
  writeFileSync(backup, raw);

  if (id === null) {
    state = { file, previous: null, set_at: null, unset_at: new Date().toISOString() };
  } else {
    state = { file, previous, set_at: new Date().toISOString(), id };
  }
  writeFileSync(file, setTopLevelKey(raw, "default_agent", id));
  mkdirSync(join(dataDir(), "state"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 1));
  return { file, previous, current: id, backup };
}


export interface UpstreamState {
  id: string;
  version: string;
  source: string | null;
  ref: string | null;
  local_commit: string | null;
  upstream_commit: string | null;
  relation: "same" | "differs" | "unknown" | "local-only";
  verify_ok: boolean;
}

/** 安装态 vs 上游：本地 commit 与 `git ls-remote <source> <ref>` 比对。 */
export function checkUpstream(id: string, version?: string): UpstreamState {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const v = version || (active.effective(id)?.version ?? readdirSync(idDir).sort().pop()!);
  const lock = JSON.parse(readFileSync(join(idDir, v, "dia.lock"), "utf8"));
  const vres = verify(id, v);
  const out: UpstreamState = {
    id, version: v,
    source: lock.source ?? null, ref: lock.ref ?? null,
    local_commit: lock.commit ?? null, upstream_commit: null,
    relation: "unknown", verify_ok: vres.ok,
  };
  const src = lock.source ?? "";
  if (!(src.startsWith("git+") || /^https?:\/\//.test(src) || src.startsWith("git@"))) {
    out.relation = "local-only";
    return out;
  }
  try {
    const url = src.replace(/^git\+/, "");
    const ref = lock.ref || "HEAD";
    const r = execFileSync("git", ["ls-remote", url, ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const sha = r.split(/\s+/)[0] || null;
    out.upstream_commit = sha;
    out.relation = sha && lock.commit && sha === lock.commit ? "same" : sha ? "differs" : "unknown";
  } catch {
    out.relation = "unknown";
  }
  return out;
}

/** 从记录源重新取回（update/heal）：装到新版本号后把 active 指针指过去。 */
export function update(id: string, opts: { ref?: string } = {}): { installed: Installed; previous: string | null } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const cur = active.effective(id)?.version ?? readdirSync(idDir).sort().pop()!;
  const lock = JSON.parse(readFileSync(join(idDir, cur, "dia.lock"), "utf8"));
  if (!lock.source) throw new Error("E_SOURCE: 该 persona 由本地目录安装，无法 update（重新 persona add）");
  const host = (lock.rendered?.[0] ?? "").includes("agents") ? "opencode" : undefined;
  const r = install(lock.source, { ref: opts.ref ?? lock.ref ?? undefined, host });
  const u = active.use(id, r.version, { reason: `update from ${lock.source}` });
  return { installed: r, previous: u.previous };
}
