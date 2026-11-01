// jsonc.ts — 最小 JSONC 支持：去注释 / 尾逗号（读），保留原文的顶层键编辑（写）。
//
// 为什么自己写：dia 的依赖面刻意保持最小（见 docs/architecture.md）；
// 为什么写回要保留原文：opencode 的 opencode.jsonc 里常有用户注释与排版，
// `JSON.parse` + `JSON.stringify` 会把它们抹掉。
//
// 只支持「顶层对象的一个键」这一种编辑——够用且可验证；其它形态一律走 parse 后校验。

/** 去掉注释与尾逗号，得到可交给 JSON.parse 的严格 JSON。 */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

export interface Entry {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** 顶层对象的成员（按出现顺序）。 */
export function topLevelEntries(text: string): Entry[] {
  const { open, close } = topLevelObject(text);
  const out: Entry[] = [];
  let i = open + 1;
  while (i < close) {
    i = skipTrivia(text, i);
    if (i >= close) break;
    if (text[i] === ",") { i++; continue; }
    if (text[i] !== '"') { i = skipValue(text, i); continue; }
    const keyStart = i;
    const keyEnd = skipString(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    i = skipTrivia(text, keyEnd);
    if (text[i] !== ":") { i = keyEnd; continue; }
    const valueStart = skipTrivia(text, i + 1);
    const valueEnd = skipValue(text, valueStart);
    out.push({ key, keyStart, valueStart, valueEnd });
    i = valueEnd;
  }
  return out;
}

/**
 * 设置（value 为字符串）或删除（value === null）顶层键，保留注释、缩进与键顺序。
 * 写回前会重新解析校验：结果不符合预期就抛错，绝不写出坏配置。
 */
export function setTopLevelKey(text: string, key: string, value: string | null): string {
  const entries = topLevelEntries(text);
  const hit = entries.find((e) => e.key === key);

  let next: string;
  if (hit) {
    if (value === null) {
      next = removeMember(text, hit);
    } else {
      next = text.slice(0, hit.valueStart) + JSON.stringify(value) + text.slice(hit.valueEnd);
    }
  } else if (value === null) {
    next = text; // 本来就没有：幂等
  } else {
    next = insertMember(text, key, value, entries);
  }

  const parsed: any = parseJsonc(next);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("E_CONFIG: 顶层不是对象");
  if (value === null ? parsed[key] !== undefined : parsed[key] !== value) {
    throw new Error(`E_CONFIG: 改写校验失败（${key}）`);
  }
  return next;
}

// ---- 内部：扫描 ----

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = skipComment(text, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") { i++; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

/** i 指向开引号；返回闭引号之后的位置。未闭合时直接抛错。 */
function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") { j += 2; continue; }
    if (text[j] === '"') return j + 1;
    j++;
  }
  throw new Error("E_CONFIG: 字符串未闭合");
}

/** i 指向 '/'；若不是注释返回原位置。 */
function skipComment(text: string, i: number): number {
  if (text[i + 1] === "/") {
    let j = i + 2;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  }
  if (text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    if (end < 0) throw new Error("E_CONFIG: 块注释未闭合");
    return end + 2;
  }
  return i;
}

/** 跳过空白与注释。 */
function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipComment(text, i); continue; }
    break;
  }
  return i;
}

/** i 指向值的第一个字符；返回值之后的位置。 */
function skipValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"') { j = skipString(text, j); continue; }
      if (ch === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) { j = skipComment(text, j); continue; }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    throw new Error("E_CONFIG: 嵌套结构未闭合");
  }
  // 数字 / true / false / null：读到分隔符、trivia 或注释为止
  let j = i;
  while (j < text.length) {
    if (/[\s,}\]]/.test(text[j])) break;
    if (text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) break;
    j++;
  }
  return j;
}

function topLevelObject(text: string): { open: number; close: number } {
  const open = skipTrivia(text, 0);
  if (text[open] !== "{") throw new Error("E_CONFIG: 顶层不是对象");
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { i = skipString(text, i); continue; }
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipComment(text, i); continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { open, close: i }; }
    i++;
  }
  throw new Error("E_CONFIG: 顶层对象未闭合");
}

// ---- 内部：编辑 ----

function removeMember(text: string, e: Entry): string {
  let start = e.keyStart;
  let p = start - 1;
  while (p >= 0 && /\s/.test(text[p])) p--;
  const hasPrevComma = text[p] === ",";
  if (hasPrevComma) start = p;
  let end = e.valueEnd;
  if (!hasPrevComma) {
    let q = end;
    while (q < text.length && /\s/.test(text[q])) q++;
    if (text[q] === ",") end = q + 1;
  }
  return text.slice(0, start) + text.slice(end);
}

function insertMember(text: string, key: string, value: string, entries: Entry[]): string {
  const { open, close } = topLevelObject(text);
  const member = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  if (!entries.length) {
    return text.slice(0, open + 1) + `\n  ${member}\n` + text.slice(close);
  }
  const first = entries[0];
  const lineStart = text.lastIndexOf("\n", first.keyStart - 1);
  const raw = lineStart >= 0 ? text.slice(lineStart + 1, first.keyStart) : "";
  const indent = /^[ \t]*$/.test(raw) ? raw : "  ";
  return text.slice(0, open + 1) + `\n${indent}${member},` + text.slice(open + 1);
}
