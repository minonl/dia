import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import * as kit from "./kit.ts";
import * as active from "./active.ts";

// 目录惰性解析（测试与多 persona 场景 env 会变）
const dataDir = () => process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");
const cacheDir = () => process.env.DIA_CACHE_DIR || join(homedir(), ".cache", "dia", "src");
const opencodeAgents = () => process.env.DIA_OPENCODE_AGENTS_DIR || join(homedir(), ".config", "opencode", "agents");
const dshProfiles = () => process.env.DIA_DSH_PROFILES_DIR || join(homedir(), ".dsh", "profiles");
const opencodeConfig = () => process.env.DIA_OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json");

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
  commands?: { name: string; entry: string; runtime?: "bun" | "node"; env?: Record<string, string> }[];
  knowledge?: string[];
  data_root?: string;
  env?: { files?: string[]; keys?: string[] };
  capabilities?: Record<string, unknown>;
}

export interface Installed {
  id: string;
  version: string;
  dir: string;
  rendered: string[];
  hash: string;
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

function hashTree(root: string): string {
  const h = createHash("sha256");
  for (const f of walkFiles(root)) {
    h.update(relative(root, f)).update("\0").update(shaFile(f)).update("\n");
  }
  return h.digest("hex");
}

export function install(from: string, opts: { ref?: string; host?: string; dryRun?: boolean } = {}): Installed {
  const src = resolveSource(from, opts.ref);
  const m = readManifest(src.dir);
  if (m.kind !== "persona") throw new Error("E_MANIFEST: not a persona");
  const target = resolve(dataDir(), "personas", m.id, m.version);
  if (!target.startsWith(resolve(dataDir(), "personas") + sep)) throw new Error("E_MANIFEST: version escapes install dir");
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) if (!["opencode", "dsh"].includes(h)) throw new Error("E_HOST: host not implemented: " + h);
  const rendered: string[] = [];

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
      throw new Error("E_CONFLICT: agent file exists and differs; remove it first");
    }
  }

  const dshEntry = hosts.includes("dsh") ? m.entry?.dsh : undefined;
  if (hosts.includes("dsh")) {
    if (!dshEntry) throw new Error("E_MANIFEST: missing entry.dsh");
    const dshSrc = resolve(src.dir, dshEntry);
    if (!existsSync(dshSrc) || !statSync(dshSrc).isDirectory()) throw new Error("E_MANIFEST: entry.dsh dir missing");
    if (!realpathSync(dshSrc).startsWith(realpathSync(src.dir) + sep) && realpathSync(dshSrc) !== realpathSync(src.dir)) throw new Error("E_MANIFEST: entry escapes persona dir");
  }

  if (opts.dryRun) {
    if (hosts.includes("opencode")) rendered.push(join(opencodeAgents(), `${m.id}.md`));
    return { id: m.id, version: m.version, dir: target, rendered, hash: "dry-run" };
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(src.dir, target, { recursive: true, dereference: true, filter: (p: string) => !p.split(sep).includes(".git") && !p.split(sep).includes("node_modules") });

  if (hosts.includes("opencode")) {
    mkdirSync(opencodeAgents(), { recursive: true });
    const dest = join(opencodeAgents(), `${m.id}.md`);
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
    renderedDirs.push({ path: dshDest, hash: hashTree(dshDest) });
  }

  // persona 自带内容（内联 kit 语义）：baseDir = target，链接指向 persona 树自身
  const inline = kit.renderContent(target, target, m) ?? [];

  // kits：包内相对路径，装完树后逐个分发（内容归 kit，人格只引用）
  const kitRefs: { id: string; version: string }[] = [];
  for (const ref of m.kits ?? []) {
    const kitDir = resolve(target, ref);
    if (!kitDir.startsWith(target + sep)) throw new Error(`E_MANIFEST: kit escapes persona dir: ${ref}`);
    if (!existsSync(join(kitDir, "dia.json"))) throw new Error(`E_MANIFEST: kit manifest missing: ${ref}`);
    const r = kit.install(kitDir);
    kitRefs.push({ id: r.id, version: r.version });
  }

  const hash = hashTree(target);
  const renderedHashes: Record<string, string> = {};
  for (const f of rendered) renderedHashes[f] = shaFile(f);
  writeFileSync(join(target, "dia.lock"), JSON.stringify({ id: m.id, version: m.version, commit: src.commit, source: from, ref: opts.ref ?? null, hash, rendered, renderedHashes, renderedDirs, kits: kitRefs,
    content: { knowledge: m.knowledge ?? [], commands: m.commands ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null, rendered: inline },
  }, null, 1));
  return { id: m.id, version: m.version, dir: target, rendered, hash };
}

export function list(): { id: string; versions: string[] }[] {
  const root = join(dataDir(), "personas");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, versions: readdirSync(join(root, e.name)).filter((v) => statSync(join(root, e.name, v)).isDirectory()) }));
}

export function verify(id: string, version?: string): { ok: boolean; dir: string; expected: string; actual: string } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const v = version || readdirSync(idDir).sort().pop()!;
  const dir = join(idDir, v);
  const lock = JSON.parse(readFileSync(join(dir, "dia.lock"), "utf8"));
  // lock 自身不参与内容哈希
  const files = walkFiles(dir).filter((f) => basename(f) !== "dia.lock");
  const h = createHash("sha256");
  for (const f of files) h.update(relative(dir, f)).update("\0").update(shaFile(f)).update("\n");
  const real = h.digest("hex");
  let renderedOk = true;
  for (const [f, expectedHash] of Object.entries(lock.renderedHashes || {})) {
    if (!existsSync(f) || shaFile(f) !== expectedHash) renderedOk = false;
  }
  for (const d of lock.renderedDirs || []) {
    if (!existsSync(d.path) || hashTree(d.path) !== d.hash) renderedOk = false;
  }
  // persona 自带内容的产物（files 复制 / skills 软链）也要校验
  for (const r of lock.content?.rendered ?? []) {
    if (r.type === "dir") continue;
    if (!existsSync(r.path)) { renderedOk = false; continue; }
    if (r.type === "file") {
      if (shaFile(r.path) !== r.value) renderedOk = false;
    } else {
      let cur = "";
      try { cur = realpathSync(r.path); } catch { renderedOk = false; continue; }
      const want = resolve(dir, r.value);
      if (!existsSync(want) || cur !== realpathSync(want)) renderedOk = false;
    }
  }
  return { ok: real === lock.hash && renderedOk, dir, expected: lock.hash, actual: real };
}

export function remove(id: string): { removed: string[]; skipped: string[] } {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error("E_NOT_INSTALLED");
  const removed: string[] = [];
  const skipped: string[] = [];
  const allowed = resolve(opencodeAgents(), `${id}.md`);
  for (const v of readdirSync(idDir)) {
    const dir = join(idDir, v);
    const lockFile = join(dir, "dia.lock");
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, "utf8"));
      for (const d of lock.renderedDirs || []) {
        const abs = resolve(d.path);
        if (!abs.startsWith(resolve(dshProfiles()) + sep) || basename(abs) !== id) { skipped.push(abs); continue; }
        if (!existsSync(abs) || hashTree(abs) !== d.hash) { skipped.push(abs); continue; }
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
        if (abs !== allowed) { skipped.push(abs); continue; }
        const expectedHash = lock.renderedHashes?.[f];
        if (!expectedHash || !existsSync(abs) || shaFile(abs) !== expectedHash) { skipped.push(abs); continue; }
        rmSync(abs); removed.push(abs);
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

/** 读取当前默认 agent（不改文件）。 */
export function showDefaultAgent(opts: { host?: string } = {}): { file: string; current: string | null } {
  const host = opts.host ?? "opencode";
  if (host !== "opencode") throw new Error("E_HOST: only opencode has default_agent");
  const file = opencodeConfig();
  if (!existsSync(file)) return { file, current: null };
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  return { file, current: typeof cfg.default_agent === "string" ? cfg.default_agent : null };
}

/**
 * 把 persona 设为宿主的默认 agent（显式动作，不随 install 自动做）。
 *   · 写前备份原文件到 <data>/backups/；
 *   · 记录原值到 <data>/state/default-agent.json，供 --unset 精确还原；
 *   · 只改 default_agent 一个键，其余内容按原格式（2 空格缩进）写回。
 */
export function setDefaultAgent(id: string | null, opts: { host?: string } = {}): DefaultAgentResult {
  const host = opts.host ?? "opencode";
  if (host !== "opencode") throw new Error("E_HOST: only opencode has default_agent");
  const file = opencodeConfig();
  if (!existsSync(file)) throw new Error(`E_CONFIG: ${file} 不存在（先装宿主，或设 DIA_OPENCODE_CONFIG）`);
  const raw = readFileSync(file, "utf8");
  let cfg: any;
  try { cfg = JSON.parse(raw); }
  catch (e: any) { throw new Error(`E_CONFIG: ${file} 不是严格 JSON（含注释？）：${e.message}`); }

  const stateFile = join(dataDir(), "state", "default-agent.json");
  let state: any = { file, previous: null, set_at: null };
  if (existsSync(stateFile)) { try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* 忽略坏状态 */ } }
  const previous = typeof cfg.default_agent === "string" ? cfg.default_agent : null;

  let backup: string | null = null;
  const dir = join(dataDir(), "backups");
  mkdirSync(dir, { recursive: true });
  backup = join(dir, `opencode.json.${Date.now()}.bak`);
  writeFileSync(backup, raw);

  if (id === null) {
    delete cfg.default_agent;
    state = { file, previous: null, set_at: null, unset_at: new Date().toISOString() };
  } else {
    cfg.default_agent = id;
    state = { file, previous, set_at: new Date().toISOString(), id };
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
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
