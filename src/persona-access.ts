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
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

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

/** deny 的 resource 是否覆盖整个 root（`*` / root 本身 / 父链上的 glob）。 */
function coversRoot(resource: string, root: string, home: string): boolean {
  const r = normalizeResource(resource, home);
  if (r === "*" || r === "**") return true;
  if (r === root) return true;
  const base = r.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  if (base === root) return true;
  if (!base) return false;
  return root.startsWith(base.endsWith("/") ? base : base + "/");
}

interface ExistingRule extends Rule { line: number }

interface ParsedFrontmatter {
  lines: string[];
  eol: string;
  trailing: boolean;
  fmEnd: number;
  /** permissions 键所在行索引；-1 = 没有该键 */
  permLine: number;
  /** 现有序列的缩进（空格数）；无序列时为 null */
  seqIndent: number | null;
  /** 新规则插入位置（行索引，插在该位置之前） */
  insertAt: number;
  /** `permissions:` 写成了 `[]` / `null`（需改写成块序列） */
  inlineEmpty: boolean;
  existing: ExistingRule[];
}

const KEY_RE = /^([A-Za-z0-9_$.-]+)\s*:\s*(.*)$/;

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** 行内 `key: value`；不匹配返回 null。 */
function keyValue(text: string): { key: string; value: string } | null {
  const m = text.trim().match(KEY_RE);
  if (!m) return null;
  return { key: m[1], value: unquote(m[2]) };
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const raw = text.split(eol);
  const trailing = raw.length > 1 && raw[raw.length - 1] === "";
  if (trailing) raw.pop();
  const lines = raw;

  if (!lines.length || lines[0].trim() !== "---") {
    throw err("agent 文件缺少 frontmatter（首行必须是 ---；access 合成只支持 YAML frontmatter）");
  }
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { fmEnd = i; break; }
  }
  if (fmEnd < 0) throw err("frontmatter 缺少收尾 ---");

  for (let i = 1; i < fmEnd; i++) {
    if (/^[ ]*\t/.test(lines[i]) || lines[i].startsWith("\t")) {
      throw err(`frontmatter 用了 tab 缩进（第 ${i + 1} 行），不支持`);
    }
  }

  let permLine = -1;
  for (let i = 1; i < fmEnd; i++) {
    const line = lines[i];
    if (indentOf(line) !== 0) continue;
    if (!/^permissions\s*:/.test(line)) continue;
    permLine = i;
    break;
  }

  const base: ParsedFrontmatter = {
    lines, eol, trailing, fmEnd, permLine,
    seqIndent: null, insertAt: fmEnd, inlineEmpty: false, existing: [],
  };
  if (permLine < 0) return base;

  const inline = lines[permLine].replace(/^permissions\s*:/, "").trim();
  if (inline !== "[]" && (inline.startsWith("[") || inline.startsWith("{"))) {
    throw err(`permissions 是 flow-style（permissions: [ … ]），不支持；请改成块列表`);
  }
  if (inline !== "" && inline !== "[]" && inline !== "null" && inline !== "~") {
    throw err(`permissions 结构不支持：${JSON.stringify(inline)}`);
  }

  // 收集子行：首个「列 0 且非空」的行结束该块
  const childIdx: number[] = [];
  let stop = fmEnd;
  for (let i = permLine + 1; i < fmEnd; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) === 0) { stop = i; break; }
    childIdx.push(i);
  }
  base.insertAt = stop;

  if (!childIdx.length) {
    // `permissions: []` / `null` / 空：都视为空列表，块内紧跟键行写入（不能跑到后面的顶层键之后）
    base.inlineEmpty = inline !== "";
    base.insertAt = permLine + 1;
    return base;
  }

  const seqIndent = indentOf(lines[childIdx[0]]);
  if (!lines[childIdx[0]].trimStart().startsWith("-")) {
    throw err(`permissions 下不是列表（第 ${childIdx[0] + 1} 行）：V1 map 形式（key: effect）不支持，请改成块列表`);
  }

  const items: { start: number; lines: number[] }[] = [];
  for (const i of childIdx) {
    const ind = indentOf(lines[i]);
    const isItem = ind === seqIndent && lines[i].trimStart().startsWith("-");
    if (isItem) { items.push({ start: i, lines: [i] }); continue; }
    if (!items.length) throw err(`permissions 下不是列表（第 ${i + 1} 行）`);
    if (ind < seqIndent) throw err(`permissions 缩进异常（第 ${i + 1} 行）`);
    items[items.length - 1].lines.push(i);
  }

  for (const item of items) {
    const rule: Partial<ExistingRule> = { line: item.start + 1 };
    for (let k = 0; k < item.lines.length; k++) {
      const idx = item.lines[k];
      let content = lines[idx];
      if (k === 0) content = content.trimStart().replace(/^-\s*/, "");
      if (content.trim() === "") continue;
      const kv = keyValue(content);
      if (!kv) throw err(`permissions 下有非列表项 / 非法键值（第 ${idx + 1} 行）：${lines[idx].trim()}`);
      if (kv.key === "action") rule.action = kv.value;
      else if (kv.key === "resource") rule.resource = kv.value;
      else if (kv.key === "effect") rule.effect = kv.value;
    }
    if (!rule.action && !rule.resource && !rule.effect) {
      throw err(`permissions 下有非列表项（第 ${item.start + 1} 行）`);
    }
    if (rule.action && rule.resource && rule.effect) base.existing.push(rule as ExistingRule);
  }
  base.seqIndent = seqIndent;
  // 插在最后一个子行之后（保留后面的顶层键，如 browser: deny）
  base.insertAt = childIdx[childIdx.length - 1] + 1;
  return base;
}

/** 声明 → 期望追加的规则（顺序即安全语义，见 docs/persona-install.md §5.5.1）。 */
function desiredRules(root: string, access: AccessDecl): Rule[] {
  const glob = `${root}/**`;
  const out: Rule[] = [
    { action: "external_directory", resource: glob, effect: "allow" },
  ];
  if (access.read === true) out.push({ action: "read", resource: glob, effect: "allow" });
  out.push({ action: "edit", resource: glob, effect: access.write === true ? "allow" : "deny" });
  if (access.read === true && access.env !== true) {
    // 读整个 root 会把 .env 一起放开；这两条必须排在 read allow 之后才生效
    out.push({ action: "read", resource: `${root}/*.env`, effect: "ask" });
    out.push({ action: "read", resource: `${root}/*.env.*`, effect: "ask" });
  }
  return out;
}

/**
 * 把 access 声明合成进 agent 文件的 frontmatter。
 * 只追加到 `permissions` 序列尾部；已存在同 (action, 归一化 resource, effect) 则跳过。
 * 结构与冲突异常抛 `E_MANIFEST`（fail closed）。
 */
export function composeAgentText(text: string, opts: ComposeOptions): ComposeResult {
  const home = resolve(opts.homedir);
  const root = resolveDataRoot(opts.id, opts.dataRoot, home);
  const access: AccessDecl = {
    read: opts.access?.read === true,
    write: opts.access?.write === true,
    env: opts.access?.env === true,
  };
  const parsed = parseFrontmatter(text);
  const wants = desiredRules(root, access);

  const skip = new Set<Rule>();
  for (const want of wants) {
    for (const cur of parsed.existing) {
      if (cur.action !== want.action) continue;
      if (normalizeResource(cur.resource, home) !== normalizeResource(want.resource, home)) continue;
      if (cur.effect !== want.effect) {
        throw err(
          `permissions 第 ${cur.line} 行已有 ${cur.action} ${cur.resource} ${cur.effect}，` +
          `与 access 合成的 ${want.effect} 冲突（同 action/resource 不同 effect）`,
        );
      }
      skip.add(want);
    }
  }
  // 更宽的 deny 会覆盖我们要追加的 allow → 拒绝（不要静默改写别人的安全边界）
  for (const want of wants) {
    if (want.effect !== "allow" || skip.has(want)) continue;
    for (const cur of parsed.existing) {
      if (cur.effect !== "deny") continue;
      if (cur.action !== "*" && cur.action !== want.action) continue;
      if (!coversRoot(cur.resource, root, home)) continue;
      throw err(
        `permissions 第 ${cur.line} 行已有更宽的 deny（${cur.action} ${cur.resource} deny）` +
        `会覆盖 access 合成的 allow（${want.action} ${want.resource}）`,
      );
    }
  }

  const rules = wants.filter((w) => !skip.has(w));
  if (!rules.length) {
    return { text, added: 0, skipped: skip.size, root };
  }

  const indent = " ".repeat(parsed.seqIndent ?? 2);
  const emitted = rules.flatMap((r) => [
    `${indent}- action: ${r.action}`,
    `${indent}  resource: ${r.resource}`,
    `${indent}  effect: ${r.effect}`,
  ]);

  const lines = [...parsed.lines];
  if (parsed.permLine < 0) {
    lines.splice(parsed.fmEnd, 0, "permissions:", ...emitted);
  } else if (parsed.inlineEmpty) {
    lines[parsed.permLine] = "permissions:";
    lines.splice(parsed.permLine + 1, 0, ...emitted);
  } else if (parsed.seqIndent === null) {
    // `permissions:` 后面没有列表（null）→ 直接补序列
    lines.splice(parsed.insertAt, 0, ...emitted);
  } else {
    lines.splice(parsed.insertAt, 0, ...emitted);
  }

  return { text: lines.join(parsed.eol) + (parsed.trailing ? parsed.eol : ""), added: rules.length, skipped: skip.size, root };
}
