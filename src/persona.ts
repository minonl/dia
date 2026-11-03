import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import * as kit from "./kit.ts";
import * as config from "./config.ts";
import * as active from "./active.ts";
import { parseJsonc, setTopLevelKey } from "./jsonc.ts";

// 目录惰性解析（测试与多 persona 场景 env 会变）
const dataDir = () => process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");
const cacheDir = () => process.env.DIA_CACHE_DIR || join(homedir(), ".cache", "dia", "src");
const opencodeAgents = () => process.env.DIA_OPENCODE_AGENTS_DIR || join(homedir(), ".config", "opencode", "agents");
const dshProfiles = () => process.env.DIA_DSH_PROFILES_DIR || join(homedir(), ".dsh", "profiles");
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

function hashTree(root: string): string {
  const h = createHash("sha256");
  for (const f of walkFiles(root)) {
    h.update(relative(root, f)).update("\0").update(shaFile(f)).update("\n");
  }
  return h.digest("hex");
}

export function install(from: string, opts: { ref?: string; host?: string; dryRun?: boolean; force?: boolean } = {}): Installed {
  const src = resolveSource(from, opts.ref);
  const m = readManifest(src.dir);
  if (m.kind !== "persona") throw new Error("E_MANIFEST: not a persona");
  const target = resolve(dataDir(), "personas", m.id, m.version);
  if (!target.startsWith(resolve(dataDir(), "personas") + sep)) throw new Error("E_MANIFEST: version escapes install dir");
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) if (!["opencode", "dsh"].includes(h)) throw new Error("E_HOST: host not implemented: " + h);
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

  if (opts.dryRun) {
    if (hosts.includes("opencode")) rendered.push(join(opencodeAgents(), `${m.id}.md`));
    return { id: m.id, version: m.version, dir: target, rendered, hash: "dry-run", commit: src.commit, overwrites };
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(src.dir, target, { recursive: true, dereference: true, filter: (p: string) => !p.split(sep).includes(".git") && !p.split(sep).includes("node_modules") });

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

  // persona 自带内容（内联 kit 语义）：baseDir = target，链接指向 persona 树自身
  const inline = kit.renderContent(target, target, m) ?? [];
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

  const hash = hashTree(target);
  const renderedHashes: Record<string, string> = {};
  for (const f of rendered) renderedHashes[f] = shaFile(f);
  writeFileSync(join(target, "dia.lock"), JSON.stringify({ id: m.id, version: m.version, commit: src.commit, source: from, ref: opts.ref ?? null, hash, rendered, renderedHashes, renderedDirs, kits: kitRefs,
    content: { knowledge: m.knowledge ?? [], commands: m.commands ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null, rendered: inline, config: appliedConfig },
  }, null, 1));
  return { id: m.id, version: m.version, dir: target, rendered, hash, commit: src.commit, overwrites };
}

export function list(): { id: string; versions: string[] }[] {
  const root = join(dataDir(), "personas");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, versions: readdirSync(join(root, e.name)).filter((v) => statSync(join(root, e.name, v)).isDirectory()) }));
}

/**
 * 版本目录解析（`dia persona path` 的唯一实现）。
 * version 缺省 ⇒ **生效版本**（active 指针，无指针回退最新安装）——与 scope.current 同口径，
 * 供服务入口 / 脚本取「当前生效的 persona 快照目录」，别让消费方自己拼 personas/<id>/<ver>。
 */
export function dirOf(id: string, version?: string): { dir: string; version: string } | null {
  const v = version || active.effective(id)?.version;
  if (!v) return null;
  const dir = join(dataDir(), "personas", id, v);
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

export function verify(id: string, version?: string): VerifyResult {
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

function skeleton(id: string, hosts: string[]): Record<string, string> {
  const manifest: any = {
    schema: 1, kind: "persona", id, name: id, version: "0.1.0",
    hosts,
    entry: {},
    capabilities: { tools: ["bash", "git"], network: false, env: [] },
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
export function create(id: string, opts: { dir?: string; hosts?: string[]; dryRun?: boolean } = {}): CreateResult {
  if (!ID_RE.test(id)) throw new Error("E_MANIFEST: bad id（小写字母/数字/中划线）");
  if (!opts.dir) throw new Error("E_USAGE: --dir required");
  const dir = resolve(opts.dir);
  const hosts = opts.hosts?.length ? opts.hosts : ["opencode", "dsh"];
  for (const h of hosts) if (!["opencode", "dsh"].includes(h)) throw new Error("E_HOST: host not implemented: " + h);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`E_CONFLICT: ${dir} 非空`);
  const files = skeleton(id, hosts);
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
export interface RenderResult { id: string; version: string; check: boolean; drift: RenderDrift[]; backups: string[] }

// 宿主会在自己的 profile 目录里改写/生成这些文件（dsh 每次启动重写 cordis.yml），
// 它们不属于渲染产物：比对时跳过，否则 --check 永远报 drift。
const HOST_OWNED_FILES = new Set(["cordis.yml"]);

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
export function render(id: string, opts: { host?: string; check?: boolean } = {}): RenderResult {
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error(`E_NOT_INSTALLED: persona ${id}`);
  const version = active.effective(id)?.version ?? readdirSync(idDir).filter((v) => statSync(join(idDir, v)).isDirectory()).sort().pop()!;
  const dir = join(idDir, version);
  const m = readManifest(dir);
  const hosts = opts.host ? [opts.host] : (m.hosts ?? ["opencode"]);
  for (const h of hosts) if (!["opencode", "dsh"].includes(h)) throw new Error("E_HOST: host not implemented: " + h);

  const drift: RenderDrift[] = [];
  let agentSrc: string | null = null, agentDest: string | null = null;
  let dshSrc: string | null = null, dshDest: string | null = null;

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
  if (dshDest && dshSrc) {
    rmSync(dshDest, { recursive: true, force: true });
    mkdirSync(dshDest, { recursive: true });
    cpSync(dshSrc, dshDest, { recursive: true });
    writeFileSync(join(dshDest, ".dia-managed"), JSON.stringify({ id, version }, null, 1));
  }

  // 只更新渲染产物记录；persona 内容哈希（lock.hash）不变。
  const lockPath = join(dir, "dia.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const rendered: string[] = [...new Set([...(lock.rendered ?? []), ...(agentDest ? [agentDest] : [])])];
  const renderedHashes: Record<string, string> = { ...(lock.renderedHashes ?? {}) };
  if (agentDest) renderedHashes[agentDest] = shaFile(agentDest);
  const renderedDirs = [...(lock.renderedDirs ?? []).filter((d: any) => d.path !== dshDest)];
  if (dshDest) renderedDirs.push({ path: dshDest, hash: hashTree(dshDest) });
  writeFileSync(lockPath, JSON.stringify({ ...lock, rendered, renderedHashes, renderedDirs }, null, 1));
  return { id, version, check: false, drift, backups };
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
        if (abs !== allowed) { skipped.push(abs); continue; }
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
