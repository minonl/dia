// kit.ts — 内容包安装（设计见 docs/kit-install.md）
//
// persona 决定「你是谁」，kit 决定「你会什么」：知识树 / skill / PATH 命令 / 运行时目录 / 宿主配置。
// 约束：**不执行安装脚本**、来源白名单、路径不得越界、每产物 sha256 记账、手改过的拒绝删除。
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

// 目录在调用时解析（不在模块加载时固化）：测试与多 persona 场景下 env 会变。
const dataDir = () => process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");
const cacheDir = () => process.env.DIA_CACHE_DIR || join(homedir(), ".cache", "dia", "src");
const homeDir = () => process.env.DIA_HOME || homedir();

export interface FileArtifact { from: string; to: string }
export interface SkillArtifact { from: string; name?: string; mode?: "link" | "copy"; to?: string }
export interface BinArtifact { from: string; name: string }
export interface CommandArtifact { name: string; entry: string; runtime?: "bun" | "node"; env?: Record<string, string> }

export interface KitManifest {
  schema: number;
  kind: "kit";
  id: string;
  version: string;
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

function walkFiles(root: string): string[] {
  const out: string[] = [];
  (function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === "kit.lock") continue;
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

/** 软链是否由 dia 管理：指向期望目标，或指向自家 kits 目录（含断链）。 */
function linkManaged(dest: string, wantTarget: string): boolean {
  if (!isSymlink(dest)) return false;
  let cur = "";
  try { cur = readlinkSync(dest); } catch { return false; }
  const abs = resolve(dirname(dest), cur);
  if (abs === resolve(wantTarget)) return true;
  return abs.startsWith(resolve(dataDir(), "kits") + sep);
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 内容渲染：files 复制、skills/bin 软链到 targetDir、dirs mkdir；dry-run 返回 null。 */
export function renderContent(
  baseDir: string,
  targetDir: string,
  m: ContentFields,
  opts: { dryRun?: boolean } = {},
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

  // 冲突检查：写盘前全部过一遍，避免半装
  for (const p of plans) {
    if (p.entry.type === "file" && p.content !== undefined) {
      checkTargetFree(p.dest, "file", sha256(Buffer.from(p.content, "base64")));
    } else if (p.linkTarget && (existsSync(p.dest) || isSymlink(p.dest))) {
      if (!linkManaged(p.dest, p.linkTarget)) throw new Error(`E_CONFLICT: ${p.dest} exists and is not managed`);
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

export function install(from: string, opts: { ref?: string; dryRun?: boolean; json?: boolean } = {}): KitInstallResult {
  const src = resolveSource(from, opts.ref);
  const m = readKitManifest(src.dir);
  const target = resolve(dataDir(), "kits", m.id, m.version);
  if (!target.startsWith(resolve(dataDir(), "kits") + sep)) throw new Error("E_MANIFEST: version escapes install dir");
  const kitRootRel = m.root ?? ".";
  const kitRoot = resolve(target, kitRootRel);
  if (!kitRoot.startsWith(target + sep) && kitRoot !== target) throw new Error("E_MANIFEST: root escapes kit");

  // 先做一遍纯校验（冲突检查写盘前完成，失败不留半装目录）
  const planned = renderContent(src.dir, target, m, { dryRun: true }) ?? [];
  if (opts.dryRun) return { id: m.id, version: m.version, dir: target, root: kitRoot, rendered: planned, hash: null, changed: false };

  // 落盘：先复制内容树（bin/skills 的软链指向它），再渲染
  const alreadyInstalled = existsSync(join(target, "kit.lock"));
  if (!alreadyInstalled || hashTree(src.dir) !== hashTree(target)) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(src.dir, target, { recursive: true, dereference: true, filter: (p: string) => !p.split(sep).includes(".git") && !p.split(sep).includes("node_modules") });
  }
  const rendered = renderContent(src.dir, target, m) ?? planned;

  const hash = hashTree(target);
  writeFileSync(join(target, "kit.lock"), JSON.stringify({
    id: m.id, version: m.version, commit: src.commit, root: kitRootRel, hash,
    rendered, commands: m.commands ?? [], knowledge: m.knowledge ?? [], dataRoot: m.data_root ?? null,
  }, null, 1));
  return { id: m.id, version: m.version, dir: target, root: kitRoot, rendered, hash, changed: true };
}

export function list(): { id: string; versions: string[] }[] {
  const root = join(dataDir(), "kits");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, versions: readdirSync(join(root, e.name)).filter((v) => statSync(join(root, e.name, v)).isDirectory()) }));
}

export function readLock(id: string, version?: string) {
  const idDir = join(dataDir(), "kits", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const v = version || readdirSync(idDir).sort().pop()!;
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
