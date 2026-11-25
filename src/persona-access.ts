// persona 数据根授权合成（设计见 docs/persona-install.md §5.5）
//
// 目标：persona 在 `dia.json` 里声明「我要读写 ~/.<id>-xxx 这个数据根」，
// **由 dia 在渲染时把它合成为宿主的 permissions 规则**——而不是让用户手写，
// 也不是让 persona 自带一份可能过时/过宽的规则。
//
// 三条硬约束：
//   1. 合成只追加到 `permissions` 序列**尾部**（宿主规则通常「后写覆盖前写」，
//      合成规则必须压在 `*: ask` 之后才有效）；
//   2. 一切异常 **fail closed**：抛 `E_MANIFEST`（CLI 退出 32），不写盘、不改 lock；
//   3. 纯函数：不读进程状态（homedir 由调用方注入），同输入同输出 ⇒ render 幂等。
//
// 实现用 `yaml` 包的 Document round-trip（不再手写行级解析）：
//   · 注释（列 0 / 缩进 / 行尾）、块标量里的 `---`、带引号的键、flow 写法、
//     CRLF 都由解析器原样保留；
//   · 解析出 `errors` 一律拒绝（不猜、不降级）——半懂的行级解析曾把规则插进
//     description 块、把带引号的 `"permissions":` 当成没有，结果宿主静默丢弃整个 agent。
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

export interface AccessDecl {
  read?: boolean;
  write?: boolean;
  env?: boolean;
}

export interface AccessState {
  /** 是否声明了 access（声明了才做前置校验与合成） */
  declared: boolean;
  /** 展开后的数据根绝对路径（未声明时为 null） */
  root: string | null;
  /** 归一化后的声明（缺失的键按 false 处理） */
  access: AccessDecl;
}

export interface Rule {
  action: string;
  resource: string;
  effect: string;
}

export interface ComposeOptions {
  id: string;
  dataRoot: string;
  access: AccessDecl;
  /** 家目录（测试注入；生产 = DIA_HOME || os.homedir()） */
  homedir: string;
}

export interface ComposeResult {
  text: string;
  /** 实际追加的规则条数 */
  added: number;
  /** 因已存在同键同 effect 而跳过的条数 */
  skipped: number;
  /** 展开后的数据根 */
  root: string;
}

const err = (msg: string) => new Error(`E_MANIFEST: ${msg}`);

/** 只有 `~` / `~/…` 两种写法；`~user/x` 与相对路径一律拒绝（别猜用户意图）。 */
function expandHome(p: string, home: string): string {
  const raw = p.trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  throw err(`data_root 必须形如 ~/.<id>-…（收到 ${JSON.stringify(p)}；相对路径 / ~user / $HOME 都不接受）`);
}

/**
 * 数据根的前置校验（fail closed）：
 *   · 直挂家目录一层，且基名以 `.<id>-` 开头（id=dabo → ~/.dabo-agent ✅，~/.ssh ❌）；
 *   · 不含 `..` 段、不含 glob 元字符；
 *   · 已存在时：不能是 symlink、不能是文件、realpath 不能逃出家目录。
 */
export function resolveDataRoot(id: string, dataRoot: unknown, homedirPath: string): string {
  if (typeof dataRoot !== "string" || !dataRoot.trim()) throw err("access 需要 data_root（声明 access 时数据根必填）");
  const home = resolve(homedirPath);
  const raw = dataRoot.trim();
  if (raw.split("/").includes("..")) throw err(`data_root 不能含 .. 段：${raw}`);
  if (/[*?[\]{}]/.test(raw)) throw err(`data_root 不能含 glob 元字符（* ? [ ] { }）：${raw}`);
  const root = expandHome(raw, home);
  const prefix = `.${id}-`;
  if (dirname(root) !== home) throw err(`data_root 必须直挂家目录：${raw}（期望 ${join(home, prefix + "…")}）`);
  const base = basename(root);
  if (!base.startsWith(prefix) || base.length === prefix.length) {
    throw err(`data_root 基名必须以 "${prefix}" 开头：${raw}（例如 ${join(home, `${prefix}agent`)}）`);
  }
  let st;
  try { st = lstatSync(root); } catch { return root; }
  if (st.isSymbolicLink()) throw err(`data_root 已存在且是 symlink，拒绝：${root}`);
  if (!st.isDirectory()) throw err(`data_root 已存在但不是目录：${root}`);
  const realHome = realpathSync(home);
  const realRoot = realpathSync(root);
  if (realRoot !== realHome && !realRoot.startsWith(realHome + sep)) {
    throw err(`data_root realpath 逃出家目录：${root} → ${realRoot}`);
  }
  return root;
}

/** 读 manifest 的 access 声明并做类型校验；未声明时 declared=false（不碰 data_root）。 */
export function inspectAccess(
  m: { id?: unknown; data_root?: unknown; access?: unknown },
  homedirPath: string,
): AccessState {
  const access = (m as any).access;
  if (access === undefined) return { declared: false, root: null, access: {} };
  if (access === null || typeof access !== "object" || Array.isArray(access)) {
    throw err("access 必须是对象 {read,write,env}（布尔）");
  }
  for (const k of ["read", "write", "env"] as const) {
    const v = (access as any)[k];
    if (v !== undefined && typeof v !== "boolean") throw err(`access.${k} 必须是 boolean（收到 ${JSON.stringify(v)}）`);
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) throw err("access 需要合法的 persona id");
  const root = resolveDataRoot(id, m.data_root, homedirPath);
  return {
    declared: true,
    root,
    access: { read: access.read === true, write: access.write === true, env: access.env === true },
  };
}

/** `~` / `~/` / `$HOME` / `$HOME/` 展开；尾部后缀（`/**` 与 `/*`）原样保留，不做包含推断。 */
export function normalizeResource(resource: string, homedirPath: string): string {
  const r = String(resource).trim();
  if (r === "~") return homedirPath;
  if (r.startsWith("~/")) return homedirPath + "/" + r.slice(2);
  if (r === "$HOME") return homedirPath;
  if (r.startsWith("$HOME/")) return homedirPath + "/" + r.slice(6);
  return r;
}

// ---- glob 语义 -------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** glob 里通配 token 的边界：`[` 未闭合时按字面量处理（与 globToRegExp 一致）。 */
function globTokenBounds(q: string): { first: number; lastEnd: number; has: boolean } {
  let first = -1, lastEnd = -1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === "*" || c === "?") {
      if (first < 0) first = i;
      lastEnd = i + 1;
    } else if (c === "[") {
      const end = q.indexOf("]", i + 1);
      if (end < 0) continue;
      if (first < 0) first = i;
      lastEnd = end + 1;
      i = end;
    }
  }
  return { first, lastEnd, has: first >= 0 };
}

/** 权限 resource 的 glob → 正则（opencode 的 `*` 匹配 `/`，`?` 匹配单个字符）。 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      re += ".*";
      while (glob[i + 1] === "*") i++;
    } else if (c === "?") {
      re += ".";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * 单个模式是否覆盖整棵 root 子树。
 * 先剥掉尾部 `/**` / `/*`（含连续），再用「字面前缀是祖先」+「glob 精确匹配 root/祖先」判定——
 * 不用字符串 startsWith 猜，`?` / `*` / 字符类这类都走得通。
 *
 * 注意：**花括号不是 glob**。opencode 把 `{ } [ ] ( ) |` 当字面量转义，只有 `*` / `?` 通配
 * （`[abc]` 字符类由 globToRegExp 处理）；因此 `{root,/tmp}/**` 是字面路径，**不**覆盖 root。
 */
export function singleCovers(pattern: string, root: string): boolean {
  let q = pattern.trim();
  if (!q) return false;
  for (;;) {
    if (q === "*" || q === "**") return true;
    if (q.endsWith("/**")) q = q.slice(0, -3);
    else if (q.endsWith("/*")) q = q.slice(0, -2);
    else break;
    if (!q || q === "/") return true;
  }
  const firstGlob = q.search(/[*?\[]/);
  if (firstGlob === 0) return true; // 以通配开头 ⇒ 保守视为覆盖整棵树
  const prefix = firstGlob < 0 ? q : q.slice(0, firstGlob);
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!base) return true;
  if (root === base || root.startsWith(base + "/")) return true;
  const re = globToRegExp(q);
  if (re.test(root)) return true;
  // 祖先目录也可能被 glob 命中（如 `~/*` 剥掉 `/*` 后是家目录本身，已由前缀覆盖；这里兜底 `?` / 字符类）
  for (let anc = dirname(root); anc && anc !== "/" && anc.length >= base.length; anc = dirname(anc)) {
    if (re.test(anc)) return true;
  }
  return false;
}

/**
 * deny 的 resource 是否覆盖整个 root（`*` / root 本身 / 祖先链上的 glob）。
 * 导出仅为测试：`*` / `?` 的覆盖判定必须能被单测直接抓住；花括号是字面量，不参与覆盖。
 */
export function coversRoot(resource: string, root: string, home: string): boolean {
  return singleCovers(normalizeResource(resource, home), root);
}

/**
 * 后者（pattern）作为**子树规则**是否覆盖前者（target resource）。
 * 只把 `*` / `**` / 以 `/**`、`/*` 结尾的模式视为「子树覆盖」；精确路径规则只覆盖同一 resource——
 * 这样 `read R/*.secret` 不会误判成覆盖 `read R/*.env`（避免误拒作者规则）。
 */
function subtreeCovers(pattern: string, target: string, home: string): boolean {
  // target 自身（通常是 `R/**` 或 `R/*.env`）的静态前缀 / 尾：用于识别中缀 glob。
  const tb = globTokenBounds(target);
  const targetPrefix = tb.has ? target.slice(0, tb.first) : target;
  const targetSuffix = tb.has ? target.slice(tb.lastEnd) : "";
  const raw = normalizeResource(pattern, home);
  let q = raw.trim();
  let subtree = false;
  for (;;) {
    if (q === "*" || q === "**") return true;
    if (q.endsWith("/**")) { q = q.slice(0, -3); subtree = true; continue; }
    if (q.endsWith("/*")) { q = q.slice(0, -2); subtree = true; continue; }
    break;
  }
  if (!subtree) {
    if (q === target) return true;
    // 中缀 / 裸 glob：`R/**/.env`、`**.env` 这类不以 `/**`/`/*` 结尾，
    // 但会匹配到 target 覆盖的路径。判定口径：与 target 共享静态前缀，
    // 且静态尾相同（`R/*.secret` 对 `R/*.env` 因尾不同，不误判）。
    const pb = globTokenBounds(q);
    if (pb.has && targetSuffix) {
      const pPrefix = q.slice(0, pb.first);
      // `R/**/.env` 的静态尾是 `/.env`，target `R/*.env` 的尾是 `.env`：按「边界后的文件名尾」比较
      const tail = (s: string) => s.replace(/^\/+/, "");
      const pSuffix = tail(q.slice(pb.lastEnd));
      const prefixOk = pPrefix === "" || pPrefix.startsWith(targetPrefix) || targetPrefix.startsWith(pPrefix);
      if (prefixOk && pSuffix !== "" && pSuffix === tail(targetSuffix)) return true;
    }
    return false;
  }
  if (!q || q === "/") return true;
  if (target === q || target.startsWith(q + "/")) return true;
  const re = globToRegExp(q);
  if (re.test(target)) return true;
  for (let anc = dirname(target); anc && anc !== "/" && anc.length >= q.length; anc = dirname(anc)) {
    if (re.test(anc)) return true;
  }
  return false;
}

/**
 * dest 相对「期望 frontmatter」还缺几条规则（`--check` 的 `access.missing` 口径）。
 * 读不了 dest（缺失/坏 YAML）⇒ 全部算缺；不改任何文件。
 */
export function countMissingRules(destText: string | null, expectedText: string, homedirPath: string): number {
  const home = resolve(homedirPath);
  const keyOf = (r: Rule) => ruleKey(r.action, r.resource, r.effect, home);
  const keysOf = (text: string): string[] => {
    const fm = splitFrontmatter(text);
    const doc = parseDocument(fm.text, { merge: true });
    if (doc.errors.length) throw err("frontmatter 不是合法 YAML（读取规则失败）");
    const node = doc.get("permissions");
    const js: any = doc.toJS() ?? {};
    const perms = js.permissions;
    if (perms == null) return [];
    if (!Array.isArray(perms)) throw err("permissions 必须是列表（YAML 序列）");
    return readExistingRules(perms, node, fm.text).map(keyOf);
  };
  const want = keysOf(expectedText);
  if (!destText) return want.length;
  let have: Set<string>;
  try { have = new Set(keysOf(destText)); } catch { return want.length; }
  return want.filter((k) => !have.has(k)).length;
}

interface Frontmatter {
  lines: string[];
  eol: string;
  /** 收尾 `---` 的行索引 */
  fmEnd: number;
  /** frontmatter 内容（不含两端的 `---` 行） */
  text: string;
  /** frontmatter 内容在原文件中的起始偏移（首行 `---` 之后） */
  fmStart: number;
  /** 收尾 `---` 行在原文件中的起始偏移（从这往后逐字节不动） */
  fmEndOffset: number;
}

/** 按 `\n` 切行，保留每行的原始终止符（`\r\n` / `\n` / 末行无终止符）。 */
function splitLines(text: string): { content: string; eol: string; start: number }[] {
  const out: { content: string; eol: string; start: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    const hasCr = i > start && text.charCodeAt(i - 1) === 13;
    out.push({ content: text.slice(start, hasCr ? i - 1 : i), eol: hasCr ? "\r\n" : "\n", start });
    start = i + 1;
  }
  if (start < text.length || !out.length) out.push({ content: text.slice(start), eol: "", start });
  return out;
}

/**
 * 首行 `---` 起、到下一条**列 0 且内容为 `---`** 结束（块标量里的 `---` 有缩进，不会误判）。
 * eol 按 frontmatter 块自身探测；body 由调用方按偏移逐字节保留（混合换行不被统一改写）。
 */
function splitFrontmatter(text: string): Frontmatter {
  const lines = splitLines(text);
  if (!lines.length || lines[0].content.trim() !== "---") {
    throw err("agent 文件缺少 frontmatter（首行必须是 ---；access 合成只支持 YAML frontmatter）");
  }
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i].content)) { fmEnd = i; break; }
  }
  if (fmEnd < 0) throw err("frontmatter 缺少收尾 ---（列 0 且内容为 --- 的行）");
  const fmLines = lines.slice(1, fmEnd);
  const eol = fmLines[0]?.eol || lines[0].eol || "\n";
  return {
    lines: lines.map((l) => l.content),
    eol,
    fmEnd,
    text: fmLines.map((l) => l.content).join("\n"),
    fmStart: lines[1]?.start ?? lines[0].start + lines[0].content.length,
    fmEndOffset: lines[fmEnd].start,
  };
}

interface ExistingRule extends Rule { line: number }

/** 节点在**文件**中的行号（frontmatter 第 1 行 = 文件第 2 行）。 */
function lineOf(node: any, fmText: string): number {
  const off = typeof node?.range?.[0] === "number" ? node.range[0] : 0;
  let n = 1;
  for (let i = 0; i < off && i < fmText.length; i++) if (fmText.charCodeAt(i) === 10) n++;
  return n + 1;
}

/**
 * 读现有 `permissions` 序列。
 * 校验值走 `doc.toJS()` 的解析结果（alias / merge key 已 resolve），行号仍从 AST 节点取；
 * 每一项都必须是 map，且 `action`/`resource`/`effect` 三键齐备、非空字符串、effect 合法——
 * 少一个字段 opencode 会**静默丢弃整份 agent**，所以这里一律 E_MANIFEST（fail closed）。
 */
function readExistingRules(items: any[], seqNode: any, fmText: string): ExistingRule[] {
  const out: ExistingRule[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const node = isSeq(seqNode) ? seqNode.items[i] : undefined;
    const line = lineOf(node, fmText);
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw err(`permissions 下有非列表项（第 ${line} 行）：期望 {action, resource, effect}`);
    }
    const vals: Record<string, string> = {};
    for (const key of ["action", "resource", "effect"] as const) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) {
        throw err(`permissions 第 ${line} 行的列表项缺少 ${key}（每项必须同时有 action/resource/effect）`);
      }
      const v = (item as any)[key];
      if (typeof v !== "string" || v.trim() === "") {
        throw err(`permissions 第 ${line} 行的 ${key} 必须是非空字符串（收到 ${JSON.stringify(v)}）`);
      }
      vals[key] = v;
    }
    if (!["allow", "deny", "ask"].includes(vals.effect)) {
      throw err(`permissions 第 ${line} 行的 effect 必须是 allow|deny|ask（收到 ${JSON.stringify(vals.effect)}）`);
    }
    out.push({ action: vals.action, resource: vals.resource, effect: vals.effect, line });
  }
  return out;
}

const ruleKey = (action: string, resource: string, effect: string, home: string) =>
  `${action}\0${normalizeResource(resource, home)}\0${effect}`;

/** 声明 → 期望追加的规则（顺序即安全语义，见 docs/persona-install.md §5.5.1）。 */
function desiredRules(root: string, access: AccessDecl): Rule[] {
  const glob = `${root}/**`;
  const out: Rule[] = [
    { action: "external_directory", resource: glob, effect: "allow" },
  ];
  if (access.read === true) out.push({ action: "read", resource: glob, effect: "allow" });
  out.push({ action: "edit", resource: glob, effect: access.write === true ? "allow" : "deny" });
  if (access.read === true && access.env !== true) {
    // 读整个 root 会把 .env 一起放开；这两条必须排在 read allow 之后才生效。
    // `*` 在 opencode 里匹配 `/`，所以这两条已覆盖 root 下**任意深度**的 `*.env` / `*.env.*`；
    // env=true 时不加这两条 ⇒ 数据根内所有 .env（含 romm.env 这类 token 文件）读取免确认。
    out.push({ action: "read", resource: `${root}/*.env`, effect: "ask" });
    out.push({ action: "read", resource: `${root}/*.env.*`, effect: "ask" });
  }
  return out;
}

/**
 * 把 access 声明合成进 agent 文件的 frontmatter。
 * 只追加到 `permissions` 序列尾部；已存在同 (action, 归一化 resource, effect) 则跳过。
 * 结构与冲突异常抛 `E_MANIFEST`（fail closed）；无需追加时**原样返回输入**（字节零变化）。
 */
export function composeAgentText(text: string, opts: ComposeOptions): ComposeResult {
  const home = resolve(opts.homedir);
  const root = resolveDataRoot(opts.id, opts.dataRoot, home);
  const access: AccessDecl = {
    read: opts.access?.read === true,
    write: opts.access?.write === true,
    env: opts.access?.env === true,
  };
  const fm = splitFrontmatter(text);
  const doc = parseDocument(fm.text, { merge: true });
  if (doc.errors.length) {
    const first = doc.errors[0];
    throw err(`frontmatter 不是合法 YAML：${String(first.message).split("\n")[0]}`);
  }
  if (!isMap(doc.contents) && doc.contents !== null) {
    throw err("frontmatter 顶层必须是映射（key: value）");
  }

  const wants = desiredRules(root, access);
  const permNode = doc.get("permissions");
  // 校验看解析后的 JS 值（alias / merge key 会 resolve）；只有追加规则时用 AST 节点。
  const js: any = doc.toJS() ?? {};
  const permissionsJs = js.permissions;
  if (permNode != null && !isSeq(permNode) && !Array.isArray(permissionsJs)) {
    throw err("permissions 必须是列表（YAML 序列）；map 形式（V1 的 key: effect）不支持");
  }
  const jsPerms: any[] = Array.isArray(permissionsJs) ? permissionsJs : [];
  const existing = readExistingRules(jsPerms, permNode, fm.text);

  // 去重 + 同 (action, resource) 不同 effect 冲突
  const skip = new Set<string>();
  /** 每个 skip 掉的期望规则，对应源里**最后一次**等价规则的下标（取最后一次：前面的副本可能被覆盖，最后一条才是生效的） */
  const equivAt = new Map<string, number>();
  for (const want of wants) {
    const key = ruleKey(want.action, want.resource, want.effect, home);
    existing.forEach((cur, i) => {
      if (cur.action !== want.action) return;
      if (normalizeResource(cur.resource, home) !== normalizeResource(want.resource, home)) return;
      if (cur.effect !== want.effect) {
        throw err(
          `permissions 第 ${cur.line} 行已有 ${cur.action} ${cur.resource} ${cur.effect}，` +
          `与 access 合成的 ${want.effect} 冲突（同 action/resource 不同 effect）`,
        );
      }
      skip.add(key);
      equivAt.set(key, i);
    });
  }
  // 更宽的 deny 会覆盖我们要追加的 allow/ask → 拒绝（不要静默改写别人的安全边界）
  for (const want of wants) {
    if (want.effect === "deny" || skip.has(ruleKey(want.action, want.resource, want.effect, home))) continue;
    for (const cur of existing) {
      if (cur.effect !== "deny") continue;
      if (cur.action !== "*" && cur.action !== want.action) continue;
      if (!coversRoot(cur.resource, root, home)) continue;
      throw err(
        `permissions 第 ${cur.line} 行已有更宽的 deny（${cur.action} ${cur.resource} deny）` +
        `会覆盖 access 合成的 ${want.effect}（${want.action} ${want.resource}）`,
      );
    }
  }
  // 顺序校验：等价规则虽然存在（added=0），但它**后面**还有会覆盖它的规则 ⇒ 静默失效。
  // 不自动重排（重排会改作者语义），让作者把顺序调好或删掉冲突规则。
  for (const want of wants) {
    const key = ruleKey(want.action, want.resource, want.effect, home);
    const at = equivAt.get(key);
    if (at === undefined) continue;
    const target = normalizeResource(want.resource, home);
    for (let i = at + 1; i < existing.length; i++) {
      const later = existing[i];
      if (later.effect === want.effect) continue;
      if (later.action !== "*" && later.action !== want.action) continue;
      if (!subtreeCovers(later.resource, target, home)) continue;
      throw err(
        `permissions 第 ${existing[at].line} 行的 ${want.action} ${want.resource} ${want.effect} 会被` +
        `第 ${later.line} 行的 ${later.action} ${later.resource} ${later.effect} 覆盖（后写优先）——` +
        `请调整顺序：让生效的规则排在覆盖它的规则之后（或删掉冲突规则）`,
      );
    }
  }

  const rules = wants.filter((w) => !skip.has(ruleKey(w.action, w.resource, w.effect, home)));
  const skipped = wants.length - rules.length;
  if (!rules.length) return { text, added: 0, skipped, root };

  if (isSeq(permNode)) {
    for (const r of rules) permNode.add(doc.createNode(r));
  } else {
    // 顶层 alias（`permissions: *p`）：用解析后的值 + 新规则重建序列节点
    doc.set("permissions", doc.createNode([...jsPerms, ...rules]));
  }

  const composed = doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  // 防御：自己的产物必须仍是合法 YAML（否则宁可 fail closed，也不写一个宿主会丢弃的文件）
  if (parseDocument(composed, { merge: true }).errors.length) throw err("合成后 frontmatter 不是合法 YAML（拒绝写入）");

  // 只替换 frontmatter 文本块：body（含混合换行/字节）逐字节保留；frontmatter 的 eol 按块自身探测
  const fmOut = composed ? composed.split("\n").join(fm.eol) + fm.eol : "";
  const outText = text.slice(0, fm.fmStart) + fmOut + text.slice(fm.fmEndOffset);
  return { text: outText, added: rules.length, skipped, root };
}
