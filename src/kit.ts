// kit.ts — 内容包安装（设计见 docs/kit-install.md）
//
// persona 决定「你是谁」，kit 决定「你会什么」：知识树 / skill / PATH 命令 / 运行时目录 / 宿主配置。
// 约束：**不执行安装脚本**、来源白名单、路径不得越界、每产物 sha256 记账、手改过的拒绝删除。
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import * as config from "./config.ts";
import * as paths from "./paths.ts";

// 目录在调用时解析（不在模块加载时固化）：测试与多 persona 场景下 env 会变。
const dataDir = () => paths.diaHome();
const cacheDir = () => paths.srcCacheDir();
const homeDir = () => process.env.DIA_HOME || homedir();

export interface FileArtifact { from: string; to: string }
export interface SkillArtifact { from: string; name?: string; mode?: "link" | "copy"; to?: string }
export interface BinArtifact { from: string; name: string }
export interface CommandArtifact { name: string; entry: string; runtime?: "bun" | "node" | "bash"; env?: Record<string, string> }

export interface KitManifest {
  schema: number;
  kind: "kit";
  id: string;
  version: string;
  /** 双标签（如 ["git","node","hooks"]）：同一份经验可被多个领域检索到 */
  tags?: string[];
  root?: string;
  files?: FileArtifact[];
  skills?: SkillArtifact[];
  bin?: BinArtifact[];
  dirs?: string[];
  commands?: CommandArtifact[];
  knowledge?: string[];
  data_root?: string;
  requires?: Record<string, string>;
}

export interface ContentFields {
  env?: { files?: string[]; keys?: string[] };
  config?: { file: string; jsonc?: boolean; set: Record<string, unknown> }[];
  files?: FileArtifact[];
  skills?: SkillArtifact[];
  bin?: BinArtifact[];
  dirs?: string[];
  commands?: CommandArtifact[];
  knowledge?: string[];
}

export interface RenderedEntry {
  path: string;
  type: "file" | "link" | "dir";
  /** file：写入内容的 sha256；link：被指向的 kit 内相对路径 */
  value: string;
}

export interface KitInstallResult {
  id: string;
  version: string;
  dir: string;
  root: string;
  rendered: RenderedEntry[];
  hash: string | null;
  changed: boolean;
}

const sha256 = (buf: string | Buffer) => createHash("sha256").update(buf).digest("hex");
const shaFile = (p: string) => sha256(readFileSync(p));

function expandHome(p: string): string {
  const home = homeDir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(home, p);
}

/** 目标路径必须在 HOME 内（越界即拒绝），且不能是 HOME 本身。 */
function assertInsideHome(p: string): string {
  const abs = resolve(expandHome(p));
  const home = resolve(homeDir());
  if (abs === home || !abs.startsWith(home + sep)) throw new Error(`E_MANIFEST: target escapes HOME: ${p}`);
  return abs;
}

/** 源路径必须在包内。 */
function assertInside(base: string, p: string): string {
  const abs = resolve(base, p);
  const rootReal = realpathSync(base);
  if (!existsSync(abs)) throw new Error(`E_MANIFEST: source missing: ${p}`);
  const real = realpathSync(abs);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error(`E_MANIFEST: source escapes kit: ${p}`);
  return abs;
}

const EMPTY_TREE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** semver 比较（不足位补 0；预发布段按字典序）。避免 `0.1.10` 被 `0.1.9` 盖住。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.+-]/), pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    const both = !Number.isNaN(nx) && !Number.isNaN(ny);
    if (both ? nx !== ny : x !== y) return both ? nx - ny : (x < y ? -1 : 1);
  }
  return 0;
}

/** 版本目录按 semver 排序（升序）；忽略隐藏目录（`.staging` / `.install.lock`）。 */
function versionDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort(cmpVersion);
}

/** 同步睡眠（锁重试用；不引入定时器/异步） */
function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** 数据根级安装锁：跨进程互斥（O_EXCL），超过 DIA_KIT_LOCK_MS 抛 E_KIT_BUSY；陈旧锁（>120s）自动清理。 */
function withInstallLock<T>(lockFile: string, fn: () => T): T {
  const budget = Number(process.env.DIA_KIT_LOCK_MS || 5000);
  const start = Date.now();
  mkdirSync(dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const st = statSync(lockFile);
        if (Date.now() - st.mtimeMs > 120_000) { rmSync(lockFile, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > budget) throw new Error(`E_KIT_BUSY: 另一个 dia 进程正在安装 kit（锁 ${lockFile}；可用 DIA_KIT_LOCK_MS 调整等待）`);
      sleepSync(50);
    }
  }
  try { return fn(); } finally { rmSync(lockFile, { force: true }); }
}

/** 不算「内容」的目录：版本库、依赖、运行时数据（`.data` 是人格的数据根，运行时写入会污染内容哈希） */
export const TREE_SKIP = new Set([".git", "node_modules", ".data"]);

/**
 * 复制过滤：只按**相对源目录**的路径判断。
 * 用绝对路径判断会误伤——npm 全局装的 kit 路径自带 `<prefix>/lib/node_modules/…`，
 * 按绝对路径匹配 `node_modules` 会把整棵树过滤掉（实测：dia-msg 装成空 kit → E_KIT_EMPTY）。
 */
export function copyFilter(base: string): (p: string) => boolean {
  return (p: string) => !relative(base, p).split(sep).some((s) => TREE_SKIP.has(s));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  (function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (TREE_SKIP.has(e.name) || e.name === "kit.lock") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(p);
    }
  })(root);
  return out.sort();
}

function hashTree(root: string): string {
  const h = createHash("sha256");
  for (const f of walkFiles(root)) {
    h.update(relative(root, f)).update("\0").update(shaFile(f)).update("\n");
  }
  return h.digest("hex");
}

export function readKitManifest(dir: string): KitManifest {
  const p = join(dir, "dia.json");
  if (!existsSync(p)) throw new Error("E_MANIFEST: dia.json not found");
  let m: KitManifest;
  try { m = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error("E_MANIFEST: invalid json"); }
  if (m.schema !== 1) throw new Error("E_MANIFEST: unsupported schema");
  if (m.kind !== "kit") throw new Error("E_MANIFEST: not a kit");
  if (!m.id || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) throw new Error("E_MANIFEST: bad id");
  if (!m.version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) throw new Error("E_MANIFEST: bad version");
  return m;
}

function resolveSource(from: string, ref?: string): { dir: string; commit: string } {
  if (from.startsWith("git+") || /^https?:\/\//.test(from) || from.startsWith("git@")) {
    const url = from.replace(/^git\+/, "");
    const key = createHash("sha1").update(url).digest("hex").slice(0, 12);
    const dir = join(cacheDir(), key);
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!existsSync(dir)) {
      mkdirSync(cacheDir(), { recursive: true });
      try { execFileSync("git", ["clone", "--quiet", url, dir], { stdio: "pipe" }); }
      catch { rmSync(dir, { recursive: true, force: true }); throw new Error("E_SOURCE: git clone failed (check URL/credentials)"); }
    }
    try {
      git(["fetch", "--quiet", "origin"]);
      if (ref) { git(["fetch", "--quiet", "origin", ref]); git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]); }
      else { try { git(["checkout", "--quiet", "--detach", "origin/HEAD"]); } catch {} }
    } catch { throw new Error("E_SOURCE: git ref not found"); }
    return { dir, commit: git(["rev-parse", "HEAD"]).trim() };
  }
  const dir = resolve(from);
  if (!existsSync(dir)) throw new Error("E_SOURCE: path not found");
  let commit = "local";
  try { commit = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  return { dir, commit };
}

/** 目标已存在时的冲突判定：同内容 → 复用；异内容/异指向 → E_CONFLICT。 */
function checkTargetFree(path: string, kind: "file" | "link", expected: string) {
  if (!existsSync(path) && !isSymlink(path)) return;
  if (kind === "file") {
    if (!isSymlink(path) && statSync(path).isFile() && shaFile(path) === expected) return;
    throw new Error(`E_CONFLICT: ${path} exists and differs`);
  }
  if (isSymlink(path)) {
    try { if (realpathSync(path) === realpathSync(expected)) return; } catch { /* 断链 */ }
  }
  throw new Error(`E_CONFLICT: ${path} exists and is not managed`);
}

/** 软链是否由 dia 管理：指向期望目标，或指向自家 kits/personas 目录（含断链）。 */
function linkManaged(dest: string, wantTarget: string): boolean {
  if (!isSymlink(dest)) return false;
  let cur = "";
  try { cur = readlinkSync(dest); } catch { return false; }
  const abs = resolve(dirname(dest), cur);
  if (abs === resolve(wantTarget)) return true;
  // persona 升级时，旧版技能软链仍指向 personas/<id>/<旧版本>/…：同属 dia 管理，可直接覆盖
  return [join("kits"), join("personas")].some((d) => abs.startsWith(resolve(dataDir(), d) + sep));
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 内容渲染：files 复制、skills/bin 软链到 targetDir、dirs mkdir；dry-run 返回 null。 */
export function renderContent(
  baseDir: string,
  targetDir: string,
  m: ContentFields,
  opts: { dryRun?: boolean; force?: boolean } = {},
): RenderedEntry[] | null {
  type Plan = { entry: RenderedEntry; dest: string; linkTarget?: string; content?: string };
  const plans: Plan[] = [];
  for (const f of m.files ?? []) {
    const srcFile = assertInside(baseDir, f.from);
    const dest = assertInsideHome(f.to);
    plans.push({ entry: { path: dest, type: "file", value: "" }, dest, content: readFileSync(srcFile).toString("base64") });
  }
  for (const s of m.skills ?? []) {
    const srcDir = assertInside(baseDir, s.from);
    const rel = relative(baseDir, srcDir);
    const dest = assertInsideHome(s.to ?? `~/.agents/skills/${s.name ?? s.from.split("/").filter(Boolean).pop()}`);
    if ((s.mode ?? "link") === "link") {
      plans.push({ entry: { path: dest, type: "link", value: rel }, dest, linkTarget: resolve(targetDir, rel) });
    } else {
      plans.push({ entry: { path: dest, type: "dir", value: "" }, dest });
    }
  }
  for (const b of m.bin ?? []) {
    assertInside(baseDir, b.from);
    const dest = assertInsideHome(`~/.local/bin/${b.name}`);
    const rel = relative(baseDir, resolve(baseDir, b.from));
    plans.push({ entry: { path: dest, type: "link", value: rel }, dest, linkTarget: resolve(targetDir, rel) });
  }
  const dirs = (m.dirs ?? []).map((d) => assertInsideHome(d));

  // 冲突检查：写盘前全部过一遍，避免半装；--force 时备份后覆盖
  const backupDir = opts.force ? join(dataDir(), "backups", `force-${new Date().toISOString().replace(/[:.]/g, "-")}`) : "";
  for (const p of plans) {
    let conflict = false;
    try {
      if (p.entry.type === "file" && p.content !== undefined) {
        checkTargetFree(p.dest, "file", sha256(Buffer.from(p.content, "base64")));
      } else if (p.linkTarget && (existsSync(p.dest) || isSymlink(p.dest))) {
        if (!linkManaged(p.dest, p.linkTarget)) conflict = true;
      }
    } catch { conflict = true; }
    if (!conflict) continue;
    if (!opts.force) {
      if (p.entry.type === "file") throw new Error(`E_CONFLICT: ${p.dest} exists and differs`);
      throw new Error(`E_CONFLICT: ${p.dest} exists and is not managed`);
    }
    if (!isSymlink(p.dest) && existsSync(p.dest)) {
      mkdirSync(backupDir, { recursive: true });
      cpSync(p.dest, join(backupDir, basename(p.dest)));
    }
  }
  if (opts.dryRun) return plans.map((p) => p.entry);

  const rendered: RenderedEntry[] = [];
  for (const p of plans) {
    mkdirSync(dirname(p.dest), { recursive: true });
    if (p.entry.type === "file" && p.content !== undefined) {
      writeFileSync(p.dest, Buffer.from(p.content, "base64"));
      p.entry.value = shaFile(p.dest);
    } else if (p.linkTarget) {
      if (existsSync(p.dest) || isSymlink(p.dest)) unlinkSync(p.dest);
      symlinkSync(resolve(p.linkTarget), p.dest);
      p.entry.value = relative(targetDir, resolve(p.linkTarget));
    }
    rendered.push(p.entry);
  }
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
    rendered.push({ path: d, type: "dir", value: "" });
  }
  return rendered;
}


/** 简易 semver 匹配（kit 版本是 x.y.z）：精确 / ^ / ~ / >= / * */
export function satisfies(version: string, range: string): boolean {
  const r = (range || "*").trim();
  const v = version.trim().replace(/^v/, "");
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  };
  if (r === "*" || r === "") return true;
  if (r.startsWith("^")) {
    const base = r.slice(1);
    const [maj, min] = base.split(".").map(Number);
    const upper = maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`;
    return cmp(v, base) >= 0 && cmp(v, upper) < 0;
  }
  if (r.startsWith("~")) {
    const base = r.slice(1);
    const [maj, min] = base.split(".").map(Number);
    const upper = `${maj}.${min + 1}.0`;
    return cmp(v, base) >= 0 && cmp(v, upper) < 0;
  }
  if (r.startsWith(">=")) return cmp(v, r.slice(2)) >= 0;
  return cmp(v, r) === 0;
}

/** 从 dia 安装目录的 kits/<id>/ 里挑满足 range 的最高版本目录（外部 kit 引用用） */
export function resolveKitDir(id: string, range: string): string {
  const root = join(paths.installDir(), "kits", id);
  if (!existsSync(root)) throw new Error(`E_KIT_NOT_FOUND: ${id}（安装目录无 kits/${id}）`);
  // 布局一：kit 源目录（kits/<id>/dia.json，版本在清单里）——install.sh/npm 包分发的是这种
  if (existsSync(join(root, "dia.json"))) {
    const v = readKitManifest(root).version;
    if (satisfies(v, range)) return root;
    throw new Error(`E_KIT_VERSION: ${id}@${v} 不满足 ${range}`);
  }
  // 布局二：版本目录（kits/<id>/<ver>/dia.json）
  const versions = readdirSync(root)
    .filter((v) => existsSync(join(root, v, "dia.json")))
    .sort();
  const hit = versions.filter((v) => satisfies(v, range)).pop();
  if (!hit) throw new Error(`E_KIT_VERSION: ${id} 无满足 ${range} 的版本（候选：${versions.join(", ") || "无"}）`);
  return join(root, hit);
}

/** 按 id@range 从安装目录安装 */
export function installRef(ref: string): KitInstallResult {
  const at = ref.lastIndexOf("@");
  const id = at > 0 ? ref.slice(0, at) : ref;
  const range = at > 0 ? ref.slice(at + 1) : "*";
  return install(resolveKitDir(id, range));
}

export function install(from: string, opts: { ref?: string; dryRun?: boolean; json?: boolean; force?: boolean } = {}): KitInstallResult {
  const src = resolveSource(from, opts.ref);
  const m = readKitManifest(src.dir);
  const kitsRoot = resolve(dataDir(), "kits");
  const target = resolve(kitsRoot, m.id, m.version);
  if (!target.startsWith(kitsRoot + sep)) throw new Error("E_MANIFEST: version escapes install dir");
  const kitRootRel = m.root ?? ".";
  const kitRoot = resolve(target, kitRootRel);
  if (!kitRoot.startsWith(target + sep) && kitRoot !== target) throw new Error("E_MANIFEST: root escapes kit");

  // 先做一遍纯校验（冲突检查写盘前完成，失败不留半装目录）
  const hasContent = ["files", "skills", "bin", "dirs", "knowledge", "commands", "config"]
    .some((k) => ((m as any)[k]?.length ?? 0) > 0);
  if (!hasContent) throw new Error("E_MANIFEST: kit 未声明任何内容（files/skills/bin/dirs/knowledge/commands/config）");
  const planned = renderContent(src.dir, target, m, { dryRun: true, force: opts.force }) ?? [];
  if (opts.dryRun) return { id: m.id, version: m.version, dir: target, root: kitRoot, rendered: planned, hash: null, changed: false };

  return withInstallLock(join(kitsRoot, ".install.lock"), () => {
    const alreadyInstalled = existsSync(join(target, "kit.lock"));
    const changed = !alreadyInstalled || hashTree(src.dir) !== hashTree(target);

    if (changed) {
      // 原子：先在同级 .staging 建完整树 + kit.lock，再 rename 换入；中途失败不会破坏旧安装
      const staging = join(kitsRoot, ".staging", `${m.id}-${m.version}-${process.pid}-${Date.now()}`);
      mkdirSync(staging, { recursive: true });
      try {
        cpSync(src.dir, staging, { recursive: true, dereference: true, filter: copyFilter(src.dir) });
        const stagedHash = hashTree(staging);
        if (stagedHash === EMPTY_TREE_HASH) throw new Error(`E_KIT_EMPTY: kit ${m.id}@${m.version} 内容为空（检查 source 与清单路径）`);
        writeFileSync(join(staging, "kit.lock"), JSON.stringify({
          id: m.id, version: m.version, commit: src.commit, root: kitRootRel, hash: stagedHash,
          rendered: [], commands: m.commands ?? [], knowledge: m.knowledge ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null, config: [],
        }, null, 1));
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target)) {
          const bak = `${target}.old-${process.pid}-${Date.now()}`;
          renameSync(target, bak);
          try { renameSync(staging, target); rmSync(bak, { recursive: true, force: true }); }
          catch (e) { try { renameSync(bak, target); } catch { /* 回滚失败也要把原错误抛出去 */ } throw e; }
        } else {
          renameSync(staging, target);
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }

    // 渲染（软链必须指向最终 target，不能在 staging 里建）
    const rendered = renderContent(src.dir, target, m, { force: opts.force }) ?? planned;
    const appliedConfig = config.apply(m.config ?? []);
    const hash = hashTree(target);
    writeFileSync(join(target, "kit.lock"), JSON.stringify({
      id: m.id, version: m.version, commit: src.commit, root: kitRootRel, hash,
      rendered, commands: m.commands ?? [], knowledge: m.knowledge ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null, config: appliedConfig,
    }, null, 1));
    return { id: m.id, version: m.version, dir: target, root: kitRoot, rendered, hash, changed };
  });
}

/** 已安装 kit（每个 id 取最新版本），含 tags 与落盘目录 —— 供 kb 聚合检索/doctor 使用 */
export function installed(): { id: string; version: string; dir: string; tags: string[] }[] {
  const root = join(dataDir(), "kits");
  if (!existsSync(root)) return [];
  const out: { id: string; version: string; dir: string; tags: string[] }[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const versions = versionDirs(join(root, e.name));
    const version = versions[versions.length - 1];
    if (!version) continue;
    const dir = join(root, e.name, version);
    let tags: string[] = [];
    try { tags = readKitManifest(dir).tags ?? []; } catch { /* 损坏的 manifest 不影响其它 kit */ }
    out.push({ id: e.name, version, dir, tags });
  }
  return out;
}

export function list(): { id: string; versions: string[]; tags: string[] }[] {
  const root = join(dataDir(), "kits");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const versions = versionDirs(join(root, e.name));
      const latest = versions[versions.length - 1];
      let tags: string[] = [];
      if (latest) {
        try { tags = readKitManifest(join(root, e.name, latest)).tags ?? []; } catch { /* manifest 缺失不阻塞 list */ }
      }
      return { id: e.name, versions, tags };
    });
}

export function readLock(id: string, version?: string) {
  const idDir = join(dataDir(), "kits", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const v = version || versionDirs(idDir).pop()!;
  const lockFile = join(idDir, v, "kit.lock");
  if (!existsSync(lockFile)) throw new Error("E_NOT_INSTALLED");
  return { version: v, lock: JSON.parse(readFileSync(lockFile, "utf8")) };
}

export function verify(id: string, version?: string): { ok: boolean; version: string; expected: string; actual: string; drift: string[] } {
  const { version: v, lock } = readLock(id, version);
  const dir = join(dataDir(), "kits", id, v);
  const files = walkFiles(dir); // kit.lock 已被 walkFiles 排除
  const h = createHash("sha256");
  for (const f of files) h.update(relative(dir, f)).update("\0").update(shaFile(f)).update("\n");
  const actual = h.digest("hex");
  const drift: string[] = [];
  for (const r of lock.rendered as RenderedEntry[]) {
    if (r.type === "dir") continue;
    if (!existsSync(r.path)) { drift.push(`missing: ${r.path}`); continue; }
    if (r.type === "file") {
      if (shaFile(r.path) !== r.value) drift.push(`modified: ${r.path}`);
    } else {
      const want = resolve(dir, r.value);
      let cur = "";
      try { cur = realpathSync(r.path); } catch { drift.push(`broken: ${r.path}`); continue; }
      if (cur !== realpathSync(want)) drift.push(`retargeted: ${r.path}`);
    }
  }
  return { ok: actual === lock.hash && drift.length === 0, version: v, expected: lock.hash, actual, drift };
}

export function remove(id: string): { removed: string[]; skipped: string[] } {
  const idDir = join(dataDir(), "kits", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const v of readdirSync(idDir)) {
    const dir = join(idDir, v);
    const lockFile = join(dir, "kit.lock");
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, "utf8"));
      for (const r of lock.rendered as RenderedEntry[]) {
        if (r.type === "dir") continue; // dirs 不删也不记账为 skipped
        if (!existsSync(r.path) && !isSymlink(r.path)) continue;
        if (r.type === "file") {
          if (!isSymlink(r.path) && shaFile(r.path) === r.value) { unlinkSync(r.path); removed.push(r.path); }
          else skipped.push(r.path);
        } else {
          let cur = "";
          try { cur = realpathSync(r.path); } catch { skipped.push(r.path); continue; }
          const want = resolve(dir, r.value);
          if (existsSync(want) && cur === realpathSync(want)) { unlinkSync(r.path); removed.push(r.path); }
          else skipped.push(r.path);
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(idDir, { recursive: true, force: true });
  return { removed, skipped };
}
