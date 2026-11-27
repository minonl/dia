import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import * as kit from "./kit.ts";
import * as defaultMsg from "./default-msg.ts";
import * as config from "./config.ts";
import * as active from "./active.ts";
import { parseJsonc, setTopLevelKey } from "./jsonc.ts";
import * as paths from "./paths.ts";
import * as access from "./persona-access.ts";

// 目录惰性解析（测试与多 persona 场景 env 会变）
const dataDir = () => paths.diaHome();
const cacheDir = () => paths.srcCacheDir();
// 「展开 ~ 用的家目录」：DIA_HOME 优先（测试隔离），只用于 persona 声明的路径（data_root / files.to）
const homeDir = () => process.env.DIA_HOME || homedir();
const shaStr = (s: string) => createHash("sha256").update(s).digest("hex");
const opencodeAgents = () => process.env.DIA_OPENCODE_AGENTS_DIR || join(paths.xdgConfig(), "opencode", "agents");
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
const opencodeConfigDir = () => process.env.DIA_OPENCODE_CONFIG_DIR || join(paths.xdgConfig(), "opencode");
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
  /** 数据根授权：由 dia 合成为宿主的 permissions 规则（见 docs/persona-install.md §5.5） */
  access?: { read?: boolean; write?: boolean; env?: boolean };
  env?: { files?: string[]; keys?: string[] };
  config?: { file: string; jsonc?: boolean; set: Record<string, unknown> }[];
  capabilities?: Record<string, unknown>;
}

/**
 * `--rehome` 时判定「不删」的旧产物：
 *   · `user-edited`：内容与 lock 记录不符（手改）；
 *   · `kept-shared`：内容对得上，但该路径仍被别的 persona 引用（同一 codex home 的 AGENTS.md），删了会让对方 verify 挂掉。
 */
export interface RetiredKept {
  path: string;
  kept: "user-edited" | "kept-shared";
  /** kept-shared 时：引用该产物的其它 persona id */
  by?: string;
}

export interface Installed {
  id: string;
  version: string;
  dir: string;
  rendered: string[];
  hash: string;
  /** 被 --force 覆盖的已存在产物（覆盖前已备份），供 CLI 提示 */
  overwrites?: string[];
  /** --rehome 时清理掉的旧 HOME 产物（已备份后删除；lock 里记为 renderedRetired） */
  retired?: string[];
  /** --rehome 时保留的旧产物（手改 / 疑似非本 persona 的 AGENTS.md；未删除） */
  retiredKept?: string[];
  /** `retiredKept` 的明细（保留原因 / 引用者），CLI 据此给不同告警 */
  retiredKeptDetail?: RetiredKept[];
  /** --rehome 删除前写下的备份文件（<data>/backups/rehome-*） */
  retiredBackups?: string[];
  /** 默认 msg kit 的装配结果（不阻断 persona 安装；失败原因供 doctor/CLI 显示） */
  msgKit?: { ok: boolean; reason?: string; kit?: string };
  /** 来源 commit（git 源 = rev-parse HEAD；本地目录 = --short HEAD 或 "local"；dry-run = "dry-run"）。
   *  CLI 展示与 persona check 走同一条信息，避免「undefined」。 */
  commit: string;
  /** 数据根授权合成结果（未声明 access 时不出现） */
  access?: AccessReport;
}

export interface AccessReport {
  declared: boolean;
  /** 本次合成新增的规则条数（与 lock 的 access.added 同口径） */
  added: number;
  /** dest 相对期望还缺几条（只在 render/--check 报；install 时不填） */
  missing?: number;
  skipped: number;
  root: string | null;
  /** 需要人看的告警（host 不支持 / write 无 read / root 尚不存在），CLI 默认输出 */
  warnings: string[];
}

/** access 声明的告警（不改行为，只说清楚「你以为生效了但其实没有」的情况）。 */
function accessWarnings(m: Manifest, hosts: string[], root: string | null): string[] {
  const w: string[] = [];
  for (const h of hosts) {
    if (h === "dsh" || h === "codex") w.push(`access 对 host=${h} 本期不生效`);
  }
  if (m.access?.write === true && m.access?.read !== true) {
    w.push("access: write=true 但 read!=true（只加写规则，读仍按宿主默认）");
  }
  if (root && !existsSync(root)) w.push(`access.data_root 尚不存在：${root}`);
  return w;
}

function planAccess(m: Manifest, hosts: string[], home = homeDir()): { state: access.AccessState; warnings: string[] } {
  const state = access.inspectAccess(m, home);
  return { state, warnings: state.declared ? accessWarnings(m, hosts, state.root) : [] };
}

/**
 * 合成 opencode entry 的期望字节（未声明 access → null，保持零回归）。
 * `home` 缺省 = 当前家目录；verify 会传 lock 里记录的家目录（换 HOME 重跑不应误报）。
 */
function composeEntry(m: Manifest, state: access.AccessState, entryAbs: string, home = homeDir()): access.ComposeResult | null {
  if (!state.declared) return null;
  return access.composeAgentText(readFileSync(entryAbs, "utf8"), {
    id: m.id,
    dataRoot: String(m.data_root),
    access: m.access ?? {},
    homedir: home,
  });
}

function shaFile(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  (function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (kit.TREE_SKIP.has(e.name)) continue;
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
  // access 声明在这里就校验（类型 / data_root 路径 / 逃逸），保证所有入口 fail closed
  access.inspectAccess(m, homeDir());
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

export function install(from: string, opts: { ref?: string; host?: string; home?: string; dryRun?: boolean; force?: boolean; ownedFrom?: string; rehome?: boolean } = {}): Installed {
  const src = resolveSource(from, opts.ref);
  const m = readManifest(src.dir);
  if (m.kind !== "persona") throw new Error("E_MANIFEST: not a persona");
  const slot = slotOf(m.version, src.commit);
  const idDir = resolve(dataDir(), "personas", m.id);
  // 布局与 versionDirs/dirOf/slotDir 同源：已存在 `versions/`（新布局）时新槽位也写进去，
  // 否则 update 产出的平铺槽位会被 versionDirs 忽略（active.use 直接 E_VERSION）。
  const nestedLayout = existsSync(join(idDir, "versions"));
  const target = resolve(nestedLayout ? join(idDir, "versions", slot) : join(idDir, slot));
  if (!target.startsWith(resolve(dataDir(), "personas") + sep)) throw new Error("E_MANIFEST: version escapes install dir");
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) assertHost(h);
  const acc = planAccess(m, hosts);
  // --rehome 只在「这次就合成 opencode 授权」时有语义：它会改写 access.homedir 与 agent md。
  // 非 opencode 宿主单独跑 --rehome 只会让 lock 出现 homedir=B / root=A 的矛盾状态，直接拒绝。
  if (opts.rehome === true && !hosts.includes("opencode")) {
    throw new Error("E_USAGE: --rehome 只在与 opencode 合成的同一次操作里生效（本次不含 opencode 宿主，access.homedir 不会迁移）；请先对 opencode 运行 dia persona render <id> --rehome");
  }
  let composed: access.ComposeResult | null = null;
  const rendered: string[] = [];
  const overwrites: string[] = [];
  // --rehome 隐含「允许覆盖同 id 的既有产物」（迁移家目录必须能改写旧 HOME 写下的 agent md），
  // 不需要再额外叠加 --force。
  const allowOverwrite = opts.force === true || opts.rehome === true;
  let opencodeDest: string | null = null;
  let codexDestPath: string | null = null;

  // 跨 HOME 闸门（与 verify/render 同口径）：已有槽位 / 上一版 lock 记录的家目录必须与当前一致，
  // 否则 add --force / update 会绕过 render/verify 的保护，把指向旧 HOME 的授权写进当前 HOME。
  // --force 的语义是覆盖重装：坏 lock **只登记、先备份**，真正的备份放到所有前置校验之后
  // （评审 HIGH 4：提前把坏 lock 移走，后续安装失败就会留下「槽位无 lock」→ remove 静默半卸载）。
  const badLocks: { lockPath: string; label: string; content: string; backup?: string }[] = [];
  const gateLock = (lockPath: string, label: string): any => {
    if (!existsSync(lockPath)) return null;
    try {
      const lock = readLockStrict(lockPath);
      assertHomeMatches(lock, m.id, "install", opts.rehome === true);
      return lock;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!opts.force || !msg.startsWith("E_LOCKED")) throw e;
      // 原文件不动（copy 备份）；内容留一份在内存里，失败时按需写回。
      badLocks.push({ lockPath, label, content: readFileSync(lockPath, "utf8") });
      return null;
    }
  };
  const prevLock = opts.ownedFrom
    ? gateLock(join(slotDir(idDir, opts.ownedFrom), "dia.lock"), opts.ownedFrom)
    : null;
  // 目标槽位的 lock 也要先过闸（放在 staging 之前，失败不留临时目录）
  const existingTargetLock = gateLock(join(target, "dia.lock"), slot);

  // 升级（update 传入 ownedFrom）时：上一版 lock 记录过的渲染产物 = dia 托管，
  // 内容变化属于正常升级 → 可覆盖（先备份）。普通 add/重装不带 ownedFrom，仍按冲突拒绝（保护手改）。
  const ownedRendered = new Set<string>();
  if (prevLock) {
    for (const p of Object.keys(prevLock.renderedHashes ?? {})) ownedRendered.add(resolve(p));
    for (const p of prevLock.rendered ?? []) ownedRendered.add(resolve(p));
  }

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
    // 期望字节：声明了 access 时是「源 + 合成规则」，否则就是源字节（零回归）
    composed = composeEntry(m, acc.state, entryAbs);
    const expectedEntry = composed ? Buffer.from(composed.text) : readFileSync(entryAbs);
    const dest = join(opencodeAgents(), `${m.id}.md`);
    opencodeDest = dest;
    if (existsSync(dest) && !readFileSync(dest).equals(expectedEntry)) {
      // 手改/旧版本的产物：默认拒绝；--force / --rehome 才覆盖，且覆盖前先备份（覆盖不丢东西）
      if (!allowOverwrite && !ownedRendered.has(resolve(dest))) throw new Error("E_CONFLICT: agent file exists and differs; remove it first (或 --force 覆盖，覆盖前会备份)");
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
    codexDestPath = dest;
    if (existsSync(dest) && !readFileSync(dest).equals(readFileSync(abs))) {
      if (!allowOverwrite) throw new Error("E_CONFLICT: codex AGENTS.md exists and differs; use --force (备份后再覆盖)");
      overwrites.push(dest);
    }
  }

  const report: AccessReport | undefined = acc.state.declared
    ? { declared: true, added: composed?.added ?? 0, skipped: composed?.skipped ?? 0, root: acc.state.root, warnings: acc.warnings }
    : undefined;

  // 旧 HOME 残留的渲染产物（--rehome 后不再产出的 agent md / codex AGENTS.md）：
  // 记入 renderedRetired 并从 rendered/renderedHashes 移除，删前打印路径（CLI 输出）。
  // 归属/手改校验在 staleRenderDests 里做：哈希不符的一律保留并告警。
  const keepDests = [opencodeDest, codexDestPath].filter((p): p is string => !!p);
  const retirePlan: RetirePlan = opts.rehome === true
    ? staleRenderDests([existingTargetLock, prevLock], m.id, keepDests)
    : { remove: [], kept: [] };
  const retired = retirePlan.remove;
  const retiredKept = retirePlan.kept.map((k) => k.path);
  const retiredKeptDetail: RetiredKept[] = retirePlan.kept;

  if (opts.dryRun) {
    if (hosts.includes("opencode")) rendered.push(opencodeDest!);
    if (hosts.includes("codex")) rendered.push(codexDestPath!);
    return { id: m.id, version: slot, dir: target, rendered, hash: "dry-run", commit: src.commit, overwrites, retired, retiredKept, retiredKeptDetail, ...(report ? { access: report } : {}) };
  }

  // dsh profile 是宿主领地：不是 dia 管理的就别碰。
  // 这个检查必须在任何写盘之前（评审 HIGH 4：晚于 opencode agent md 写入会造成「半安装」）。
  const dshDestEarly = hosts.includes("dsh") ? resolve(dshProfiles(), m.id) : null;
  if (dshDestEarly && existsSync(dshDestEarly) && !existsSync(join(dshDestEarly, ".dia-managed"))) {
    throw new Error("E_CONFLICT: dsh profile exists and is not managed by dia");
  }

  // 所有前置校验到此结束：现在才备份坏 lock（复制；原文件仍留在原位，见 gateLock 注释）。
  for (const b of badLocks) b.backup = backupBadLock(m.id, b.lockPath, b.label);
  // 安装中途失败时把坏 lock 写回原位（极端情况：槽位目录已被替换成没有 lock 的新目录）。
  const restoreBadLocks = () => {
    for (const b of badLocks) {
      if (!existsSync(b.lockPath) && existsSync(dirname(b.lockPath))) {
        try { writeFileSync(b.lockPath, b.content); } catch { /* 尽力恢复 */ }
      }
    }
  };

  // 原子安装：staging → 写 lock → rename；同槽位不同内容判冲突，绝不原地覆盖
  mkdirSync(idDir, { recursive: true });
  const lockPath = join(idDir, ".lock");
  let lockFd: number | null = null;
  // 幂等复用槽位时不能对 target 重新 hashTree：target 里已经有上次写的 dia.lock，
  // 会把 lock 自身算进内容哈希 ⇒ verify 恒 mismatch。复用就用旧 lock 的 hash（= stagingHash）。
  let reuseTarget = false;
  let stagingHashState: string | null = null;
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
    cpSync(src.dir, staging, { recursive: true, dereference: true, filter: kit.copyFilter(src.dir) });
    const stagingHash = hashTree(staging);
    stagingHashState = stagingHash;
    if (existsSync(target)) {
      // 坏 lock 被 --force 备份后 existingTargetLock 为 null：回退到实际内容哈希比较，
      // 避免同内容重装被误判成 E_VERSION_COLLISION（仅在有 dia.json 的完整槽位上比较）。
      const targetHash = existingTargetLock
        ? existingTargetLock.hash
        : existsSync(join(target, "dia.json")) ? hashTree(target) : null;
      if (targetHash !== null && targetHash === stagingHash) {
        // 幂等：同槽位同内容 → 不重装版本，但仍要跑一遍宿主渲染（--force 时恢复被手改的产物）
        rmSync(staging, { recursive: true, force: true });
        reuseTarget = true;
      } else if (!opts.force) {
        rmSync(staging, { recursive: true, force: true });
        throw new Error(`E_VERSION_COLLISION: ${m.id}@${slot} 已存在且内容不同（换 commit/ref 会得到新槽位；或 --force 覆盖 / 删除该槽位后重试）`);
      } else {
        rmSync(target, { recursive: true, force: true });
      }
    }
    if (!reuseTarget) renameSync(staging, target);
  } finally {
    if (lockFd !== null) { try { closeSync(lockFd); } catch {} }
    try { rmSync(lockPath, { force: true }); } catch {}
  }

  try {
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
      // 声明了 access → 写合成后的字节；否则按原字节复制（零回归）
      if (composed) writeFileSync(dest, composed.text);
      else cpSync(entryAbs2, dest);
      rendered.push(dest);
    }

    const renderedDirs: { path: string; hash: string }[] = [];
    if (hosts.includes("dsh")) {
      const dshDest = resolve(dshProfiles(), m.id);
      const keptBlocks = (() => {
        try { return managedBlocks(readFileSync(join(dshDest, "cordis.patch.yml"), "utf8")); } catch { return ""; }
      })();
      rmSync(dshDest, { recursive: true, force: true });
      mkdirSync(dshDest, { recursive: true });
      cpSync(resolve(target, dshEntry!), dshDest, { recursive: true });
      if (keptBlocks) {
        const f = join(dshDest, "cordis.patch.yml");
        writeFileSync(f, readFileSync(f, "utf8").replace(/\n?$/, "\n") + keptBlocks);
      }
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
    const inline = [...(kit.renderContent(target, target, inlineManifest, { force: opts.force, owned: ownedRendered }) ?? []), ...codexLinks];
    const appliedConfig = config.apply((m.config ?? []) as any);

    // kits：包内相对路径，装完树后逐个分发（内容归 kit，人格只引用）
    const kitRefs: { id: string; version: string; range?: string }[] = [];
    for (const ref of m.kits ?? []) {
      const isPath = ref.startsWith(".") || ref.includes("/");
      if (isPath) {
        const kitDir = resolve(target, ref);
        if (!kitDir.startsWith(target + sep)) throw new Error(`E_MANIFEST: kit escapes persona dir: ${ref}`);
        if (!existsSync(join(kitDir, "dia.json"))) throw new Error(`E_MANIFEST: kit manifest missing: ${ref}`);
        const r = kit.install(kitDir);
        kitRefs.push({ id: r.id, version: r.version });
      } else {
        // 外部引用：`<id>[@<range>]`，从 dia 安装目录的 kits/ 解析（2026-11-09）
        const r = kit.installRef(ref);
        const at = ref.lastIndexOf("@");
        kitRefs.push({ id: r.id, version: r.version, range: at > 0 ? ref.slice(at + 1) : "*" });
      }
    }

    // 默认能力包（dia-msg）：不阻断 persona 安装；显式 capabilities.msg=false 或用户 disable 时跳过。
    const msgKit = defaultMsg.ensureForPersona(m.id, m.capabilities);

    const hash = reuseTarget && existingTargetLock?.hash ? existingTargetLock.hash : (stagingHashState ?? hashTree(target));
    const renderedHashes: Record<string, string> = {};
    for (const f of rendered) renderedHashes[f] = shaFile(f);

    // --rehome：旧 HOME 的 agent md / codex AGENTS.md 不再被本次安装产出 →
    // **先备份到 <data>/backups/rehome-<id>-<ts>/ 再删**（与 render drift 同一套流程）。
    // 手改/非本 persona 的（staleRenderDests 判过哈希）留在 retirePlan.kept 里，不删。
    const retiredBackups: string[] = [];
    const retiredActual: string[] = [];
    if (opts.rehome === true && retirePlan.remove.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const r = backupAndRemove(retirePlan.remove, join(dataDir(), "backups", `rehome-${m.id}-${stamp}`));
      retiredBackups.push(...r.backups);
      retiredActual.push(...r.removed);
    }
    // renderedRetired：已删的记字符串；保留的记 `{ path, kept, by? }`，供人/诊断区分。
    const retiredRecord: any[] = [
      ...retiredActual,
      ...retirePlan.kept.map((k) => ({ path: k.path, kept: k.kept, ...(k.by ? { by: k.by } : {}) })),
    ];
    // 上一版槽位的 lock 也要把这些旧产物记为 retired，否则删旧版本时 verify 恒 missing / remove 报 30。
    if (opts.rehome === true && prevLock && opts.ownedFrom) {
      const prevDir = slotDir(idDir, opts.ownedFrom);
      if (resolve(prevDir) !== resolve(target)) {
        // 保留的项同样不再归 dia 管：从上一版 lock 的 rendered/renderedHashes 里剪掉。
        const stale = new Set([...retirePlan.remove, ...retirePlan.kept.map((k) => k.path)].map((p) => resolve(p)));
        const keptRendered = (prevLock.rendered ?? []).filter((p: string) => !stale.has(resolve(p)));
        const keptHashes: Record<string, string> = {};
        for (const [p, h] of Object.entries(prevLock.renderedHashes ?? {})) {
          if (!stale.has(resolve(p))) keptHashes[p] = h as string;
        }
        writeFileSync(join(prevDir, "dia.lock"), JSON.stringify({
          ...prevLock,
          rendered: keptRendered,
          renderedHashes: keptHashes,
          renderedRetired: mergeRetired(prevLock.renderedRetired ?? [], retiredRecord),
        }, null, 1));
      }
    }

    writeFileSync(join(target, "dia.lock"), JSON.stringify({ id: m.id, version: m.version, slot, commit: src.commit, source: from, ref: opts.ref ?? null, installedAt: new Date().toISOString(), hash, rendered, renderedHashes, renderedDirs, renderedRetired: retiredRecord, kits: kitRefs,
      access: { declared: acc.state.declared, added: composed?.added ?? 0, skipped: composed?.skipped ?? 0, root: acc.state.root, homedir: homeDir() },
      content: { knowledge: m.knowledge ?? [], commands: m.commands ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null, rendered: inline, config: appliedConfig },
    }, null, 1));
    recordSource(m.id, slot, from, opts.ref);
    return { id: m.id, version: slot, dir: target, rendered, hash, commit: src.commit, overwrites, retired: retiredActual, retiredKept, retiredKeptDetail: retirePlan.kept, retiredBackups, msgKit, ...(report ? { access: report } : {}) };
  } catch (e) {
    restoreBadLocks();
    throw e;
  }
}

export function list(): { id: string; versions: string[] }[] {
  const root = join(dataDir(), "personas");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, versions: versionDirs(join(root, e.name)) }));
}

// `personas/<id>/` 下不是版本槽位的保留目录。
// `backups` 是历史坏 lock 备份的落点（`<idDir>/backups/`）；现在备份统一放
// `<data>/backups/persona-locks/<id>/`，但历史安装可能还留着它——必须显式排除，
// 否则 `persona list` 会报假版本、active 会指到它、gc 会把它当旧版本删掉。
const RESERVED_PERSONA_DIRS = new Set(["backups", "current", "latest", "data", "repo", "repo.git", "worktrees", "versions"]);

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
  if (existsSync(verRoot)) return scan(verRoot, (n) => !RESERVED_PERSONA_DIRS.has(n));
  const keep = (n: string) => !RESERVED_PERSONA_DIRS.has(n) && !n.startsWith(".staging-") && n !== ".lock";
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
  const dir = slotDir(join(dataDir(), "personas", id), v);
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
    rmSync(slotDir(idDir, v), { recursive: true, force: true });
    removed.push(v);
  }
  return { kept, removed, skipped };
}

/**
 * 严格读 `dia.lock`：存在但解析失败 / 顶层不是对象（含 `null`）一律拒绝，
 * **绝不降级成 `{}` 再整份写回**——那会把 hash/commit/rendered/kits 永久抹掉。
 */
function readLockStrict(lockPath: string): any {
  const fail = (why: string) => new Error(
    `E_LOCKED: dia.lock 无法使用（${why}）：${lockPath}\n` +
    `  请先备份该文件后重装（dia persona add/update --force），或从备份恢复；lock 残缺时拒绝写盘`,
  );
  let raw: string;
  try { raw = readFileSync(lockPath, "utf8"); } catch (e: any) { throw fail(`读取失败：${e?.message ?? e}`); }
  let lock: any;
  try { lock = JSON.parse(raw); } catch (e: any) { throw fail(`不是合法 JSON：${e?.message ?? e}`); }
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw fail(`顶层必须是对象（收到 ${JSON.stringify(lock)}）`);
  }
  return lock;
}

/**
 * 坏 lock 的备份：复制到 `<data>/backups/persona-locks/<id>/dia.lock.bak-<label>-<ts>`。
 *
 * 两个约束来自评审：
 *   · **不能**放 `personas/<id>/` 里——那会被当成版本槽位（假版本 / active 指到它 / gc 删掉）。
 *     改用与 render 备份同级的 `<data>/backups/`。
 *   · 只复制、不移动（copy 备份）。原文件留在原位，后续安装失败时槽位仍有 lock，
 *     `remove` 不会静默半卸载；安装成功写新 lock 时自然覆盖。
 */
function backupBadLock(id: string, lockPath: string, label: string): string {
  const dir = join(dataDir(), "backups", "persona-locks", id);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = String(label).replace(/[^A-Za-z0-9._+-]/g, "_");
  let dest = join(dir, `dia.lock.bak-${safe}-${stamp}`);
  for (let i = 1; existsSync(dest); i++) dest = join(dir, `dia.lock.bak-${safe}-${stamp}-${i}`);
  cpSync(lockPath, dest);
  return dest;
}

/** 安装来源旁路记录（`<data>/state/persona-sources.json`，按 id/slot）：lock 损坏时 update --force 仍能找回 source。
 *  不放 `<idDir>` 里，避免污染 `personas/<id>` 的目录列举（版本扫描/测试都假定那里只有槽位目录）。 */
function sourceRecordPath(): string {
  return join(dataDir(), "state", "persona-sources.json");
}

function readSourceRecord(id: string): Record<string, { source: string; ref?: string | null }> {
  try {
    const all = JSON.parse(readFileSync(sourceRecordPath(), "utf8"));
    const v = all && typeof all === "object" ? all[id] : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function recordSource(id: string, slot: string, source: string, ref?: string | null): void {
  try {
    let all: any = {};
    try { all = JSON.parse(readFileSync(sourceRecordPath(), "utf8")) ?? {}; } catch { all = {}; }
    if (!all || typeof all !== "object" || Array.isArray(all)) all = {};
    const mine = all[id] && typeof all[id] === "object" ? all[id] : {};
    mine[slot] = { source, ref: ref ?? null };
    all[id] = mine;
    mkdirSync(join(dataDir(), "state"), { recursive: true });
    writeFileSync(sourceRecordPath(), JSON.stringify(all, null, 1));
  } catch { /* 旁路记录失败不阻断安装（lock 才是权威） */ }
}

/**
 * 旧 HOME 残留的「同一角色的渲染产物」：不再由本次渲染产出、但 lock 曾记录为 dia 写的
 * agent md（`<id>.md`）/ codex `AGENTS.md`。只对**本次确实会产出的角色**判定，
 * 避免 `render --host opencode` 顺手删掉 codex 的产物。
 *
 * **归属校验**（评审）分两道：
 *   ① 当前文件哈希 == 本 persona lock 里记录的哈希（否则手改，保留）；
 *   ② 该路径没有被**别的 persona** 的 lock 引用（`rendered` / `renderedHashes` / `renderedRetired`）。
 *      两个 codex persona 共用同一 home 且 AGENTS.md 内容相同时，①会误判成自己的；②必须拦下，
 *      否则删掉后对方的 verify 直接 MISMATCH。
 */
interface RetirePlan { remove: string[]; kept: RetiredKept[] }

/**
 * 扫描**其它已安装 persona 槽位**的 lock，收集它们登记过的渲染产物（path → 引用者 id）。
 * 坏 lock 静默跳过（清理路径不能因为别人 lock 坏了就整体失败，只能保守保留到自己能读到的部分）。
 */
function otherPersonaRefs(ownId: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const root = join(dataDir(), "personas");
  if (!existsSync(root)) return refs;
  let ids: string[] = [];
  try { ids = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return refs; }
  for (const id of ids) {
    if (id === ownId) continue;
    const idDir = join(root, id);
    for (const v of versionDirs(idDir)) {
      const lockPath = join(slotDir(idDir, v), "dia.lock");
      if (!existsSync(lockPath)) continue;
      let lock: any;
      try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch { continue; }
      if (!lock || typeof lock !== "object" || Array.isArray(lock)) continue;
      const add = (p: unknown) => {
        if (typeof p !== "string" || !p) return;
        const abs = resolve(p);
        const list = refs.get(abs) ?? [];
        if (!list.includes(id)) list.push(id);
        refs.set(abs, list);
      };
      if (Array.isArray(lock.rendered)) for (const p of lock.rendered) add(p);
      if (lock.renderedHashes && typeof lock.renderedHashes === "object") {
        for (const p of Object.keys(lock.renderedHashes)) add(p);
      }
      if (Array.isArray(lock.renderedRetired)) {
        for (const e of lock.renderedRetired) add(typeof e === "string" ? e : e?.path);
      }
    }
  }
  return refs;
}

function staleRenderDests(locks: any[], id: string, keepDests: string[]): RetirePlan {
  const keep = new Set(keepDests.map((p) => resolve(p)));
  const wantAgent = keepDests.some((p) => basename(p) === `${id}.md`);
  const wantCodex = keepDests.some((p) => basename(p) === "AGENTS.md" && basename(dirname(p)) === ".codex");
  const recorded = new Map<string, string>();
  for (const lock of locks) {
    for (const [p, h] of Object.entries((lock?.renderedHashes ?? {}) as Record<string, string>)) {
      if (typeof h === "string") recorded.set(resolve(p), h);
    }
  }
  const candidates = new Set<string>();
  for (const lock of locks) {
    for (const p of lock?.rendered ?? []) {
      const abs = resolve(p);
      if (keep.has(abs)) continue;
      const isAgent = wantAgent && basename(abs) === `${id}.md`;
      const isCodex = wantCodex && basename(abs) === "AGENTS.md" && basename(dirname(abs)) === ".codex";
      if (isAgent || isCodex) candidates.add(abs);
    }
  }
  const remove: string[] = [];
  const kept: RetiredKept[] = [];
  // 只为真正要判定的候选路径扫别人的 lock（render 每次都会跑本函数，避免无谓的全库扫描）
  let sharedRefs: Map<string, string[]> | null = null;
  const sharedBy = (p: string): string[] => (sharedRefs ??= otherPersonaRefs(id)).get(p) ?? [];
  for (const p of candidates) {
    if (!existsSync(p) && !isSymlink(p)) { remove.push(p); continue; }
    // ① 哈希对不上 → 不是本 persona 的字节（手改 / 别人写的），保留
    const want = recorded.get(p);
    const mine = !isSymlink(p) && !!want && shaFile(p) === want;
    const by = sharedBy(p);
    if (!mine) { kept.push({ path: p, kept: "user-edited", ...(by.length ? { by: by[0] } : {}) }); continue; }
    // ② 哈希对得上但别的 persona 还引用它（字节相同的共享 AGENTS.md）→ 保留，否则对方 verify 挂
    if (by.length) { kept.push({ path: p, kept: "kept-shared", by: by[0] }); continue; }
    remove.push(p);
  }
  return { remove, kept };
}

/**
 * `renderedRetired` 合并去重：已删项是字符串，保留项是 `{ path, kept }`。
 * 按 path 去重，避免反复 rehome 时数组无限增长。
 */
function mergeRetired(prev: any[], add: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const e of [...(prev ?? []), ...add]) {
    const key = typeof e === "string" ? `p:${e}` : `k:${e?.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** 保留项的告警文案（codex `AGENTS.md` 同名冲突 / 共享引用要说得更明白）。 */
export function retireKeptWarnings(kept: { path: string; kept: string; by?: string }[]): string[] {
  return kept.map((k) => {
    if (k.kept === "kept-shared") {
      return `保留 ${k.path}：该产物被其它 persona（${k.by ?? "?"}）引用，已保留（kept-shared）`;
    }
    const isCodex = basename(k.path) === "AGENTS.md" && basename(dirname(k.path)) === ".codex";
    const shared = k.by ? `（也被其它 persona（${k.by}）引用）` : "";
    return isCodex
      ? `保留 ${k.path}：内容与 lock 记录不符，疑似非本 persona 产物${shared}，已保留`
      : `保留 ${k.path}：内容已被手改（kept-user-edited）${shared}，未删除`;
  });
}

/**
 * `--rehome` 清理旧产物：**先备份再删**（与 render drift 同流程，落 `<data>/backups/<bdir>`）。
 * 调用方已用 staleRenderDests 做过归属/哈希校验，这里的 paths 只含确认可删的。
 */
function backupAndRemove(paths: string[], bdir: string): { removed: string[]; backups: string[] } {
  const removed: string[] = [];
  const backups: string[] = [];
  let made = false;
  for (const p of paths) {
    if (!existsSync(p) && !isSymlink(p)) { removed.push(p); continue; }
    if (!made) { mkdirSync(bdir, { recursive: true }); made = true; }
    let dest = join(bdir, basename(p));
    for (let i = 1; existsSync(dest); i++) dest = join(bdir, `${basename(p)}.${i}`);
    if (isSymlink(p)) writeFileSync(`${dest}.symlink`, readlinkSync(p));
    else cpSync(p, dest, { recursive: true });
    backups.push(dest);
    rmSync(p, { force: true });
    removed.push(p);
  }
  return { removed, backups };
}

/**
 * lock 记录了安装时的家目录 → 当前 HOME 必须一致；否则拒绝（避免把指向别人家目录的授权
 * 写到当前 HOME 的 agents 目录）。给两条出路：换回原 HOME，或显式 `--rehome` 迁移。
 * `allowRehome=true`（调用方已看到 --rehome）时直接放行。
 */
function assertHomeMatches(
  lock: any,
  id: string,
  action: "render" | "verify" | "install" | "update",
  allowRehome = false,
): void {
  if (allowRehome) return;
  const recordedHome = typeof lock.access?.homedir === "string" ? lock.access.homedir : null;
  if (!recordedHome) return;
  const currentHome = homeDir();
  if (resolve(recordedHome) === resolve(currentHome)) return;
  const rehome = action === "update"
    ? `dia persona update ${id} --rehome`
    : action === "install"
      ? `dia persona add ${id} … --rehome`
      : `dia persona render ${id} --rehome`;
  throw new Error(
    `E_MANIFEST: 当前 HOME（${currentHome}）与该 persona 安装时记录的 access.homedir（${recordedHome}）不同；` +
    `为避免把指向旧家目录的数据根授权写到当前 HOME 的 agents 目录，已拒绝。` +
    `两条出路：① 切换到安装时的 HOME（${recordedHome}）；② 确认迁移到当前 HOME 时显式运行 ${rehome}` +
    (action === "verify" ? "（再 verify）" : ""),
  );
}

export function verify(id: string, version?: string): VerifyResult {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const v = version || active.effective(id)?.version || versionDirs(idDir).sort((a, b) => cmpSemver(b, a))[0];
  if (!v) throw new Error("E_NOT_INSTALLED");
  const dir = existsSync(join(idDir, "versions", v)) ? join(idDir, "versions", v) : join(idDir, v);
  const lock = readLockStrict(join(dir, "dia.lock"));
  assertHomeMatches(lock, id, "verify");
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

  // access 合成与 lock 同步校验：源没变但期望字节变了（dia 升级改了合成规则）⇒ 需要重渲染。
  // 用 lock 记录的家目录重算（换 DIA_HOME/HOME 重跑不该误报）；access 的校验错误向上抛
  // E_MANIFEST（CLI 退出 32），不再降级成一条可被忽略的 issue。
  const m = JSON.parse(readFileSync(join(dir, "dia.json"), "utf8")) as Manifest;
  if (m.access !== undefined) {
    try {
      const recordedHome = typeof lock.access?.homedir === "string" ? lock.access.homedir : homeDir();
      const st = access.inspectAccess(m, recordedHome);
      if (st.declared) {
        const entry = m.entry?.opencode;
        const dest = join(opencodeAgents(), `${id}.md`);
        if (entry && lock.renderedHashes?.[dest]) {
          const want = composeEntry(m, st, resolve(dir, entry), recordedHome);
          if (want && shaStr(want.text) !== lock.renderedHashes[dest]) {
            issues.push(`access 合成与 lock 记录不一致（重跑 dia persona render ${id}）`);
          }
        }
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // access 的声明/路径/合成错误一律 fail closed（32）；entry 文件缺失等其它问题仍报 issue
      if (msg.startsWith("E_MANIFEST")) throw e;
      issues.push(`access 合成校验失败：${msg}`);
    }
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
export interface RenderResult { id: string; version: string; check: boolean; drift: RenderDrift[]; backups: string[]; retired: string[]; retiredKept?: string[]; retiredKeptDetail?: RetiredKept[]; msgKit?: { ok: boolean; reason?: string; kit?: string }; access?: AccessReport }

// 宿主会在自己的 profile 目录里改写/生成这些文件（dsh 每次启动重写 cordis.yml，
// `dsh plugin --profile <id> add <pkg>` 会改 package.json 与锁文件），它们不属于渲染产物：
// 比对时跳过、写回时不覆盖，否则 --check 永远报 drift，且 re-render 会回退宿主运行态。
// 与 docs/persona-install.md §5.3 一致：profile 目录是宿主领地，dia 只关心自己写的字节。
const MANAGED_BLOCK_RE = /# >>> dia-managed:[^\n]*\n[\s\S]*?# <<< dia-managed:[^\n]*\n/g;
/** 提取宿主侧「dia 管理块」（如 dsh 插件 insert）：persona 更新时保留，不当作漂移。 */
export function managedBlocks(text: string): string {
  return (text.match(MANAGED_BLOCK_RE) || []).join("");
}
/** 期望内容 = 源文件 + 实际文件里的管理块（渲染与 compareDir 共用）。 */
function withManagedBlocks(srcText: string, actualText: string): string {
  const blocks = managedBlocks(actualText);
  return blocks ? `${srcText.replace(/\n?$/, "\n")}${blocks}` : srcText;
}

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
    if (!existsSync(dest)) { out.push({ path: dest, action: "missing" }); continue; }
    if (rel === "cordis.patch.yml") {
      const want = withManagedBlocks(readFileSync(f, "utf8"), readFileSync(dest, "utf8"));
      if (want !== readFileSync(dest, "utf8")) out.push({ path: dest, action: "changed" });
      continue;
    }
    if (shaFile(dest) !== shaFile(f)) out.push({ path: dest, action: "changed" });
  }
  return out;
}

/**
 * 用**已安装版本**重渲染到宿主（不换内容）。`check` 只报 drift、不写盘。
 * 覆盖策略：被手改/丢失的产物先备份到 `<data>/backups/render-<ts>/`，再写回。
 */
export function render(id: string, opts: { host?: string; home?: string; check?: boolean; version?: string; rehome?: boolean } = {}): RenderResult {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error(`E_NOT_INSTALLED: persona ${id}`);
  const version = opts.version
    ? resolveVersion(id, opts.version)
    : (active.effective(id)?.version ?? versionDirs(idDir).sort((a, b) => cmpSemver(b, a))[0]!);
  const dir = slotDir(idDir, version);
  const m = readManifest(dir);
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) assertHost(h);

  if (opts.check && opts.rehome) {
    throw new Error("E_USAGE: --check 与 --rehome 互斥（先单独运行 dia persona render <id> --rehome 迁移到当前 HOME，再跑 --check）");
  }
  // --rehome 只在「这次就合成 opencode 授权」时有语义：它要改 access.homedir 与 agent md。
  // 对 dsh|codex 单独 --rehome 只会让 lock 出现 homedir=B / root=A 的矛盾状态 → 明确拒绝。
  if (opts.rehome === true && !hosts.includes("opencode")) {
    throw new Error("E_USAGE: --rehome 只在与 opencode 合成的同一次操作里生效（本次 --host 不含 opencode，access.homedir 不会迁移）；请先运行 dia persona render <id> --rehome");
  }
  // homedir 口径统一：lock 里记了安装时的家目录就以它为准（render/verify/renderDrift 同源）。
  // 换 HOME 重跑不再 warn 了事——直接拒绝，避免把指向旧家目录的授权写到当前 HOME。
  const lockPath = join(dir, "dia.lock");
  const lock: any = existsSync(lockPath) ? readLockStrict(lockPath) : {};
  if (opts.rehome !== true) assertHomeMatches(lock, id, "render");
  const prevAccess = lock.access && typeof lock.access === "object" ? lock.access : null;
  const recordedHome = typeof lock.access?.homedir === "string" ? lock.access.homedir : null;
  const effHome = opts.rehome === true || !recordedHome ? homeDir() : recordedHome;

  const acc = planAccess(m, hosts, effHome);
  let composed: access.ComposeResult | null = null;
  const report: AccessReport | undefined = acc.state.declared
    ? { declared: true, added: 0, missing: 0, skipped: 0, root: acc.state.root, warnings: acc.warnings }
    : undefined;
  // 非 opencode 宿主不合成 permissions：汇总行必须显示 lock 里保留的 added/skipped（而不是「追加 0 条」），
  // 否则一次 dsh 渲染就会让人误以为授权被重置。
  if (report && !hosts.includes("opencode")) {
    report.added = prevAccess?.added ?? 0;
    report.skipped = prevAccess?.skipped ?? 0;
    report.root = prevAccess?.root ?? acc.state.root;
  }

  const drift: RenderDrift[] = [];

  // 与真渲染同一套前置：内容渲染（files/skills/bin）的 dry-run 也在 --check/预检阶段跑，
  // 这样 `persona use` 的预检能提前发现坏内容（失败发生在 active.use() 之前）。
  const hostHasInline = hosts.some((h) => h === "opencode" || h === "dsh");
  const inlineManifest: any = hostHasInline ? m : { ...m, skills: [] };
  const inlinePlan = kit.renderContent(dir, dir, inlineManifest, { dryRun: true, force: true }) ?? [];
  for (const e of inlinePlan) {
    if (e.type === "dir" || e.type !== "link") continue;
    const want = resolve(dir, e.value);
    let cur = "";
    try { cur = realpathSync(e.path); } catch { drift.push({ path: e.path, action: "missing" }); continue; }
    if (cur !== realpathSync(want)) drift.push({ path: e.path, action: "changed" });
  }
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
    // drift 比对用「合成期望」：源永远是未合成的，dest 是合成后的（幂等，不会叠加）
    composed = composeEntry(m, acc.state, agentSrc, effHome);
    if (report && composed) {
      // added = 本次合成新增的规则条数（与 install / lock 同口径）；
      // missing = dest 相对期望还缺几条（只用于展示，不混进 added）。
      const destNow = existsSync(agentDest) ? readFileSync(agentDest, "utf8") : null;
      report.added = composed.added;
      report.missing = access.countMissingRules(destNow, composed.text, effHome);
      report.skipped = composed.skipped;
    }
    const wantHash = composed ? shaStr(composed.text) : shaFile(agentSrc);
    if (!existsSync(agentDest)) drift.push({ path: agentDest, action: "missing" });
    else if (shaFile(agentDest) !== wantHash) drift.push({ path: agentDest, action: "changed" });
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
  // 旧 HOME 残留：同一角色、但本次不再产出的 agent md / codex AGENTS.md（rehome 或换目录后）。
  // 这些路径不能再留在 rendered/renderedHashes（否则 verify 恒 missing、remove 报 30）；
  // 只有显式 --rehome 才删文件（非 rehome 的 --home 切换保留旧文件，避免误删共享产物）。
  // staleRenderDests 已按 lock 记录的哈希做归属校验：手改/别人的 AGENTS.md 只保留不删。
  const retirePlan = staleRenderDests([lock], id, [agentDest, codexDest].filter((p): p is string => !!p));
  const retired = opts.rehome === true ? retirePlan.remove : [];
  const retiredKept = opts.rehome === true ? retirePlan.kept.map((k) => k.path) : [];
  const retiredKeptDetail: RetiredKept[] = opts.rehome === true ? retirePlan.kept : [];
  if (opts.check) return { id, version, check: true, drift, backups: [], retired, retiredKept, retiredKeptDetail, ...(report ? { access: report } : {}) };

  // persona 自带内容（skills/bin 软链）也要重渲染：切版本后软链可能仍指旧槽位，而内容相同 → 曾漏判
  const msgKit = defaultMsg.ensureForPersona(id, m.capabilities);
  const backups: string[] = [];
  if (drift.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bdir = join(dataDir(), "backups", `render-${stamp}`);
    for (const d of drift) {
      if (!existsSync(d.path) && !isSymlink(d.path)) continue;
      mkdirSync(bdir, { recursive: true });
      const dest = join(bdir, basename(d.path));
      if (isSymlink(d.path)) writeFileSync(`${dest}.symlink`, readlinkSync(d.path));
      else cpSync(d.path, dest, { recursive: true });
      backups.push(dest);
    }
  }
  if (agentDest && agentSrc) {
    mkdirSync(dirname(agentDest), { recursive: true });
    if (composed) writeFileSync(agentDest, composed.text);
    else cpSync(agentSrc, agentDest);
  }
  if (codexDest && codexSrc) { mkdirSync(dirname(codexDest), { recursive: true }); cpSync(codexSrc, codexDest); }
  // 旧 HOME 的 agent md / codex AGENTS.md：本次已不再产出 → **先备份再删**（lock 里记为 renderedRetired）
  if (opts.rehome === true && retirePlan.remove.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const b = backupAndRemove(retirePlan.remove, join(dataDir(), "backups", `rehome-${id}-${stamp}`));
    backups.push(...b.backups);
  }
  if (dshDest && dshSrc) {
    // 只覆盖 persona 自己写入的文件，绝不整树重建：profile 目录是宿主领地，
    // 宿主装的插件目录/改动过的 package.json 不在 drift 名单里，删掉就再也回不来。
    mkdirSync(dshDest, { recursive: true });
    const keptBlocks = (() => {
      try { return managedBlocks(readFileSync(join(dshDest, "cordis.patch.yml"), "utf8")); } catch { return ""; }
    })();
    for (const f of walkFiles(dshSrc)) {
      const rel = relative(dshSrc, f);
      if (HOST_OWNED_FILES.has(rel)) continue;
      const dest = join(dshDest, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(f, dest);
    }
    if (keptBlocks) {
      const f = join(dshDest, "cordis.patch.yml");
      writeFileSync(f, readFileSync(f, "utf8").replace(/\n?$/, "\n") + keptBlocks);
    }
    writeFileSync(join(dshDest, ".dia-managed"), JSON.stringify({ id, version }, null, 1));
  }

  const inlineRendered = kit.renderContent(dir, dir, inlineManifest, { force: true }) ?? [];

  // 只更新渲染产物记录；persona 内容哈希（lock.hash）不变。
  // 旧 HOME / 旧 codex home 的渲染路径一律剪掉（记入 renderedRetired），否则 verify 恒 missing。
  // 保留项（kept）同样不再归 dia 管：剪掉记录，但在 renderedRetired 里标注原因。
  const trimSet = new Set([...retirePlan.remove, ...retirePlan.kept.map((k) => k.path)].map((p) => resolve(p)));
  const rendered: string[] = [...new Set([
    ...(lock.rendered ?? []).filter((p: string) => !trimSet.has(resolve(p))),
    ...inlineRendered.filter((e) => e.type !== "dir").map((e) => e.path),
    ...(agentDest ? [agentDest] : []),
    ...(codexDest ? [codexDest] : []),
  ])];
  const renderedHashes: Record<string, string> = { ...(lock.renderedHashes ?? {}) };
  for (const p of Object.keys(renderedHashes)) if (trimSet.has(resolve(p))) delete renderedHashes[p];
  if (agentDest) renderedHashes[agentDest] = shaFile(agentDest);
  if (codexDest) renderedHashes[codexDest] = shaFile(codexDest);
  const renderedDirs = [...(lock.renderedDirs ?? []).filter((d: any) => d.path !== dshDest)];
  if (dshDest) renderedDirs.push({ path: dshDest, hash: hashTree(dshDest) });
  // lock 里的 access 段跟着重渲染刷新，但 **added/skipped/root 只由 opencode 合成决定**：
  // `render --host dsh|codex` 不会合成 permissions，必须保留上一次（opencode）的值，
  // 否则跑一次 dsh 渲染就能把「追加 0 条」永久写进 lock。host 不生效由告警行说明。
  const accessLock = composed
    ? { declared: true, added: composed.added, skipped: composed.skipped, root: acc.state.root, homedir: effHome }
    : acc.state.declared
      ? {
          ...(prevAccess ?? {}),
          declared: true,
          added: prevAccess?.added ?? 0,
          skipped: prevAccess?.skipped ?? 0,
          root: prevAccess?.root ?? acc.state.root,
          // 只有 opencode 合成才能改 access.homedir；非 opencode 渲染沿用 lock 里的值
          homedir: prevAccess?.homedir ?? effHome,
        }
      : { declared: false, added: 0, skipped: 0, root: null };
  const renderedRetired = mergeRetired(lock.renderedRetired ?? [], [
    ...retirePlan.remove,
    ...retirePlan.kept.map((k) => ({ path: k.path, kept: k.kept, ...(k.by ? { by: k.by } : {}) })),
  ]);
  writeFileSync(lockPath, JSON.stringify({ ...lock, rendered, renderedHashes, renderedDirs, renderedRetired, access: accessLock }, null, 1));
  return { id, version, check: false, drift, backups, retired, retiredKept, retiredKeptDetail, msgKit, ...(report ? { access: report } : {}) };
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
    ?? versionDirs(idDir).sort((a, b) => cmpSemver(b, a))[0];
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

/** 槽位目录：新布局 `versions/<v>` 优先，旧平铺 `<v>` 兜底（dirOf / scope / gc / remove 共用的唯一解析器）。 */
export function slotDir(idDir: string, version: string): string {
  const nested = join(idDir, "versions", version);
  return existsSync(nested) ? nested : join(idDir, version);
}

/** 严格读取槽位 lock（不存在返回 null；坏 lock 抛 E_LOCKED）。 */
function readSlotLock(idDir: string, version: string): any | null {
  const lockPath = join(slotDir(idDir, version), "dia.lock");
  if (!existsSync(lockPath)) return null;
  return readLockStrict(lockPath);
}

/** 其它槽位仍声明持有的产物：按槽位删除时不能回收它们（宿主产物路径通常跨版本共享）。 */
function slotClaims(lock: any): { paths: Set<string>; kits: Set<string> } {
  const paths = new Set<string>();
  const kits = new Set<string>();
  if (!lock) return { paths, kits };
  for (const d of lock.renderedDirs ?? []) if (d?.path) paths.add(resolve(d.path));
  for (const r of lock.content?.rendered ?? []) if (r?.path) paths.add(resolve(r.path));
  for (const f of lock.rendered ?? []) paths.add(resolve(f));
  for (const r of lock.content?.config ?? []) if (r?.path) paths.add(resolve(r.path));
  for (const k of lock.kits ?? []) if (k?.id) kits.add(k.id);
  return { paths, kits };
}

/** 回收单个版本槽位 lock 里登记的产物（不删槽位目录本身）。lock 由调用方预读（坏 lock 先于动盘拒绝）。 */
function removeSlotArtifacts(
  id: string,
  idDir: string,
  version: string,
  lock: any,
  keep: { paths: Set<string>; kits: Set<string> } = { paths: new Set(), kits: new Set() },
): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  const dir = slotDir(idDir, version);
  if (!lock) return { removed, skipped };
  const allowed = resolve(opencodeAgents(), `${id}.md`);
  for (const d of lock.renderedDirs || []) {
    const abs = resolve(d.path);
    if (keep.paths.has(abs)) continue;
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
    const abs = resolve(r.path);
    if (keep.paths.has(abs)) continue;
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
    if (keep.paths.has(abs)) continue;
    const isCodexAgent = basename(abs) === "AGENTS.md" && basename(dirname(abs)) === ".codex";
    if (abs !== allowed && !isCodexAgent) { skipped.push(abs); continue; }
    const expectedHash = lock.renderedHashes?.[f];
    if (!expectedHash || !existsSync(abs) || shaFile(abs) !== expectedHash) { skipped.push(abs); continue; }
    rmSync(abs); removed.push(abs);
  }
  // 声明式配置：按原内容回滚（文件被改过则 skip）
  for (const r of lock.content?.config ?? []) {
    if (keep.paths.has(resolve(r.path))) continue;
    const rv = config.revert([r]);
    removed.push(...rv.restored);
    skipped.push(...rv.skipped);
  }
  // kit：随 persona 一起卸载（仍被其它槽位引用时保留）
  for (const k of lock.kits ?? []) {
    if (keep.kits.has(k.id)) continue;
    try { kit.remove(k.id); removed.push(`kit:${k.id}@${k.version}`); } catch { skipped.push(`kit:${k.id}`); }
  }
  return { removed, skipped };
}

export function remove(id: string, opts: { version?: string } = {}): { removed: string[]; skipped: string[]; version?: string } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  // 删除前先记生效版本：删完再读会变成「剩余最新」，就判断不出刚删的是不是生效槽位。
  const effective = active.effective(id);
  const selected = opts.version !== undefined ? resolveVersion(id, opts.version) : undefined;
  const all = versionDirs(idDir);
  const targets = selected ? [selected] : all;
  // 删除任何东西之前先把所有槽位 lock 解析完：任一坏 lock 都直接 32，且**一个文件都不动**
  // （旧实现边删边解析 → 第二个版本坏 lock 时留下半卸载）。
  const locks = new Map<string, any>();
  for (const v of all) locks.set(v, readSlotLock(idDir, v));
  // 按槽位删除时，其它槽位仍声明的宿主产物/kit 不能回收（agent md、dsh profile 等路径跨版本共享）
  const keep = selected
    ? all.filter((v) => v !== selected).reduce((acc, v) => {
        const c = slotClaims(locks.get(v));
        for (const p of c.paths) acc.paths.add(p);
        for (const k of c.kits) acc.kits.add(k);
        return acc;
      }, { paths: new Set<string>(), kits: new Set<string>() })
    : { paths: new Set<string>(), kits: new Set<string>() };
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const v of targets) {
    const dir = slotDir(idDir, v);
    if (!existsSync(dir)) continue;
    const r = removeSlotArtifacts(id, idDir, v, locks.get(v) ?? null, keep);
    removed.push(...r.removed);
    skipped.push(...r.skipped);
    rmSync(dir, { recursive: true, force: true });
  }
  // 历史（修复前）坏 lock 备份落在 `<idDir>/backups/`（不是版本）。versionDirs 已排除它，
  // 但删槽位时也要顺手清掉，否则它会永远留在 personas/<id>/ 里被误当版本。
  const legacyBackups = join(idDir, "backups");
  if (targets.length && existsSync(legacyBackups)) rmSync(legacyBackups, { recursive: true, force: true });
  const remaining = versionDirs(idDir);
  if (!remaining.length) {
    // 没有版本了：清掉指针，避免 scope/doctor 继续指向已删槽位
    active.clear(id);
    rmSync(idDir, { recursive: true, force: true });
  } else if (effective?.version === selected) {
    // 删的是生效版本，但还有其它槽位 → 重指到剩余最新版本（审计 reason=remove）
    active.use(id, null, { reason: "remove" });
  }
  return { removed, skipped, ...(selected ? { version: selected } : {}) };
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
  const v = version || (active.effective(id)?.version ?? versionDirs(idDir).sort((a, b) => cmpSemver(b, a))[0]!);
  const lock = readLockStrict(join(slotDir(idDir, v), "dia.lock"));
  // access 校验失败是 E_MANIFEST（CLI 退出 32）：原样冒泡，别吞成 MISMATCH/exit 2
  let verifyOk = false;
  try { verifyOk = verify(id, v).ok; } catch (e: any) {
    if (String(e?.message ?? e).startsWith("E_MANIFEST")) throw e;
    verifyOk = false;
  }
  const vres = { ok: verifyOk };
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

/**
 * 从记录源重新取回（update/heal）：装到新版本号后把 active 指针指过去。
 * `dryRun`：只预演（走 install 的 dry-run 早退），不建版本目录、不切 active、不建索引。
 */
export function update(
  id: string,
  opts: { ref?: string; force?: boolean; dryRun?: boolean; rehome?: boolean } = {},
): { installed: Installed; previous: string | null; applied?: boolean } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const cur = active.effective(id)?.version ?? versionDirs(idDir).sort((a, b) => cmpSemver(b, a))[0]!;
  const lockPath = join(slotDir(idDir, cur), "dia.lock");
  let lock: any;
  try {
    lock = readLockStrict(lockPath);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // --force = 覆盖重装：坏 lock 先备份（复制、原文件不动），再从旁路来源记录恢复 source 继续。
    if (!(opts.force && msg.startsWith("E_LOCKED"))) throw e;
    const rec = readSourceRecord(id)[cur];
    if (!rec?.source) {
      throw new Error(`E_SOURCE: dia.lock 已损坏（${lockPath}），且找不到该槽位的安装来源；请用 dia persona add <源地址> --force 重装`);
    }
    backupBadLock(id, lockPath, cur);
    lock = { source: rec.source, ref: rec.ref ?? null };
  }
  // 跨 HOME：update 会重新渲染并写 lock，必须与 render 一样要求显式 --rehome
  assertHomeMatches(lock, id, "update", opts.rehome === true);
  if (!lock.source) throw new Error("E_SOURCE: 该 persona 由本地目录安装，无法 update（重新 persona add）");
  // 不传 host：按 manifest 的 hosts 全量重渲染（旧实现用 rendered[0] 推断 host → 多 host 的 dsh profile 永不刷新）
  const r = install(lock.source, { ref: opts.ref ?? lock.ref ?? undefined, force: opts.force, ownedFrom: cur, dryRun: opts.dryRun, rehome: opts.rehome });
  if (opts.dryRun) return { installed: r, previous: cur, applied: false };
  const u = active.use(id, r.version, { reason: `update from ${lock.source}` });
  return { installed: r, previous: u.previous, applied: true };
}
