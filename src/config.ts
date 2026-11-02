// config.ts — 声明式宿主配置合并（persona/kit 的 `config` 字段）
//
// 为什么需要：`permission.external_directory`、`default_agent` 这类是宿主配置，不是文件产物。
//   kit/persona 只声明「哪个文件、把哪个键设成什么」，dia 负责读-改-写 + 原值快照回滚。
//
// 约定（沿用 docs/migrations/no-python.md 的 JSON 策略）：
//   · `*.jsonc`：读取兼容注释/尾逗号；**写回 canonical JSON**（注释会丢）→ 写前备份，并在结果里标注
//   · `*.json`：严格 JSON；解析失败即 E_CONFIG，不猜
//   · 只改声明过的键；其它键原样保留
//   · remove 时按记录的原内容回滚；文件被用户改过（hash 不符）→ skip，不覆盖
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const home = () => process.env.DIA_HOME || homedir();
const dataDir = () => process.env.DIA_DATA_DIR || join(home(), ".local", "share", "dia");
const expand = (p: string) => (p === "~" ? home() : p.startsWith("~/") ? join(home(), p.slice(2)) : p);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface ConfigEntry {
  file: string;
  jsonc?: boolean;
  set: Record<string, unknown>;
}

export interface Applied {
  path: string;
  before: string;       // 原文件内容（base64），供精确回滚
  after_sha256: string;
  set: Record<string, unknown>;
  backup: string | null;
  comments_lost: boolean;
}

/** 去注释/尾逗号：只在字符串外的位置剥离，避免误伤 URL 里的 `//`。 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0, inStr = false, quote = "", inLine = false, inBlock = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i += 2; continue; } i++; continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  // 尾逗号
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parse(text: string, jsonc: boolean): any {
  if (!jsonc) return JSON.parse(text);
  return JSON.parse(stripJsonc(text));
}

function setPath(obj: any, dotted: string, value: unknown) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

export function apply(entries: ConfigEntry[], opts: { dryRun?: boolean } = {}): Applied[] {
  const applied: Applied[] = [];
  for (const e of entries) {
    const path = expand(e.file);
    const exists = existsSync(path);
    const before = exists ? readFileSync(path, "utf8") : "";
    let doc: any = {};
    if (exists && before.trim()) {
      try { doc = parse(before, !!e.jsonc); }
      catch (err: any) { throw new Error(`E_CONFIG: ${path} 解析失败：${err.message}`); }
    }
    for (const [k, v] of Object.entries(e.set ?? {})) setPath(doc, k, v);
    const after = JSON.stringify(doc, null, 2) + "\n";
    const comments_lost = !!e.jsonc && /(^|[^:])\/\/|\/\*/.test(before);
    if (opts.dryRun) { applied.push({ path, before: "", after_sha256: sha(after), set: e.set, backup: null, comments_lost }); continue; }

    let backup: string | null = null;
    if (exists) {
      const dir = join(dataDir(), "backups");
      mkdirSync(dir, { recursive: true });
      backup = join(dir, `${path.split("/").pop()}.${Date.now()}.bak`);
      writeFileSync(backup, before);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, after);
    applied.push({ path, before: Buffer.from(before, "utf8").toString("base64"), after_sha256: sha(after), set: e.set, backup, comments_lost });
  }
  return applied;
}

/** 回滚：文件仍是 dia 写的那份 → 逐字节还原；否则 skip（用户改过，不覆盖）。 */
export function revert(records: Applied[]): { restored: string[]; skipped: string[] } {
  const restored: string[] = [], skipped: string[] = [];
  for (const r of records) {
    if (!existsSync(r.path)) { skipped.push(r.path); continue; }
    const cur = readFileSync(r.path, "utf8");
    if (sha(cur) !== r.after_sha256) { skipped.push(r.path); continue; }
    const before = Buffer.from(r.before, "base64").toString("utf8");
    if (before === "") { skipped.push(r.path); continue; } // 装前不存在 → 不删用户文件
    writeFileSync(r.path, before);
    restored.push(r.path);
  }
  return { restored, skipped };
}
