import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { openDb } from "./sqlite.ts";

const CJK = /[\u4e00-\u9fff]/g;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const SCHEMA_VERSION = 1;

export class KbIndexError extends Error {
  constructor(message: string, public code: "E_INDEX_MISSING" | "E_INDEX_STALE" = "E_INDEX_MISSING") { super(message); }
}

function cacheDir(): string {
  return process.env.DIA_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "dia", "index");
}

export interface Doc {
  path: string;
  title: string;
  text: string;
  bytes: number;
  tokens: number;
  mtime: number;
  mtimeMs: number;
  reviewBy: string;
  tags: string;
}

export function tokensEst(text: string): number {
  const han = (text.match(CJK) || []).length;
  return Math.round(han + (text.length - han) / 4);
}

export function parseFrontmatter(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  if (!text.startsWith("---")) return meta;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return meta;
  for (const line of text.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

function firstTitle(text: string, fallback: string): string {
  for (const line of text.split("\n")) if (line.startsWith("# ")) return line.slice(2).trim();
  return fallback;
}

function walk(root: string): string[] {
  const out: string[] = [];
  (function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  })(root);
  return out.sort();
}

export function iterDocs(root: string): Doc[] {
  const abs = resolve(root);
  return walk(abs).map((full) => {
    const text = readFileSync(full, "utf8");
    const meta = parseFrontmatter(text);
    return {
      path: relative(abs, full),
      title: firstTitle(text, basename(full, ".md")),
      text,
      bytes: Buffer.byteLength(text),
      tokens: tokensEst(text),
      mtime: Math.floor(statSync(full).mtimeMs / 1000),
      mtimeMs: statSync(full).mtimeMs,
      reviewBy: meta.review_by || "",
      tags: meta.tags || "",
    };
  });
}

function scanRoot(root: string): { docs: number; fingerprint: string; maxMtimeMs: number } {
  const abs = resolve(root);
  const files = walk(abs);
  let maxMtimeMs = 0;
  const parts: string[] = [];
  for (const f of files) {
    const st = statSync(f);
    maxMtimeMs = Math.max(maxMtimeMs, st.mtimeMs);
    parts.push(`${relative(abs, f)}:${st.mtimeMs}:${st.size}`);
  }
  return { docs: files.length, maxMtimeMs, fingerprint: createHash("sha1").update(parts.join("\n")).digest("hex") };
}

/** 默认索引路径（**无副作用**：不建目录，只算路径）。只读消费方（如 doctor）用它探测索引。 */
export function indexDbPath(root: string): string {
  const key = createHash("sha1").update(resolve(root)).digest("hex").slice(0, 16);
  return join(cacheDir(), key + ".db");
}

export function defaultDb(root: string): string {
  const target = indexDbPath(root);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

export async function buildIndex(root: string, dbPath?: string) {
  const target = dbPath || defaultDb(root);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const docs = iterDocs(root);
  const scan = scanRoot(root);
  const db = await openDb(tmp);
  let tokenizer = "trigram";
  try {
    db.exec("BEGIN");
    db.exec("DROP TABLE IF EXISTS docs");
    db.exec("DROP TABLE IF EXISTS docs_fts");
    db.exec("DROP TABLE IF EXISTS meta");
    db.exec("CREATE TABLE docs (path TEXT PRIMARY KEY, title TEXT, body TEXT, bytes INTEGER, tokens INTEGER, mtime INTEGER, review_by TEXT, tags TEXT)");
    try {
      db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(path UNINDEXED, title, body, tokenize='trigram')");
    } catch {
      tokenizer = "unicode61";
      db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(path UNINDEXED, title, body, tokenize='unicode61')");
    }
    for (const doc of docs) {
      db.run("INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?,?,?,?)", [doc.path, doc.title, doc.text, doc.bytes, doc.tokens, doc.mtime, doc.reviewBy, doc.tags]);
      db.run("INSERT INTO docs_fts (path, title, body) VALUES (?,?,?)", [doc.path, doc.title, doc.text]);
    }
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    const builtAt = new Date().toISOString();
    for (const [k, v] of Object.entries({
      schema: String(SCHEMA_VERSION), root: resolve(root), docs: String(docs.length),
      built_at: builtAt, max_mtime_ms: String(scan.maxMtimeMs), fingerprint: scan.fingerprint, tokenizer,
    })) db.run("INSERT INTO meta VALUES (?,?)", [k, v]);
    db.exec("COMMIT");
    db.close();
    renameSync(tmp, target);
    return { db: target, docs: docs.length, tokenizer, built_at: builtAt };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { force: true });
    throw e;
  }
}

interface IndexMeta { docs: number; max_mtime_ms: number; fingerprint: string; tokenizer: string; root: string; schema: number }
interface IndexSnapshot extends IndexMeta { rows: { path: string; mtime: number }[] }

async function readSnapshot(path: string): Promise<IndexSnapshot | null> {
  if (!existsSync(path)) return null;
  const db = await openDb(path, { readonly: true });
  try {
    const meta = db.all<any>("SELECT key, value FROM meta");
    const m = new Map(meta.map((r) => [String(r.key), String(r.value)]));
    if (!m.has("schema") || !m.has("docs")) return null;
    const rows = db.all<any>("SELECT path, mtime FROM docs").map((r) => ({ path: String(r.path), mtime: Number(r.mtime || 0) }));
    return {
      docs: Number(m.get("docs") || 0), max_mtime_ms: Number(m.get("max_mtime_ms") || 0),
      fingerprint: m.get("fingerprint") || "", tokenizer: m.get("tokenizer") || "unknown",
      root: m.get("root") || "", schema: Number(m.get("schema") || 0), rows,
    };
  } catch {
    return null;
  } finally { db.close(); }
}

async function readMeta(path: string): Promise<IndexMeta | null> {
  return await readSnapshot(path);
}

export async function assertIndex(root: string, dbPath?: string): Promise<string> {
  const target = dbPath || defaultDb(root);
  const meta = await readMeta(target);
  if (!meta || meta.schema !== SCHEMA_VERSION) {
    throw new KbIndexError(`index missing or incompatible: ${target}; run "dia kb index --root ${root}"`, "E_INDEX_MISSING");
  }
  if (meta.root !== resolve(root)) throw new KbIndexError(`index belongs to another root: ${meta.root}`, "E_INDEX_STALE");
  const scan = scanRoot(root);
  if (meta.docs !== scan.docs || meta.fingerprint !== scan.fingerprint) {
    throw new KbIndexError(`index stale: docs ${meta.docs}→${scan.docs}; run "dia kb index --root ${root}"`, "E_INDEX_STALE");
  }
  return target;
}

export type IndexState = "ok" | "missing" | "foreign" | "stale";

export interface IndexStatus {
  root: string;
  db: string;
  state: IndexState;
  /** 索引里记录的文档数 */
  indexed: number;
  /** 磁盘上现在的 .md 文档数 */
  scanned: number;
  /** 磁盘有、索引没有 */
  added: number;
  /** 索引有、磁盘没有 */
  removed: number;
  /** 两边都有但 mtime 不同 */
  changed: number;
  /** 聚合指纹不一致、逐文件却没差异（同一秒内改内容 / 大小不变） */
  contentOnly: boolean;
}

/**
 * 索引新鲜度（**只读探测**，不建目录、不重建）：doctor / 脚本判「要不要提示重建」用。
 * 判据与 `assertIndex` 完全一致（schema + root + docs 数 + 聚合指纹），只是把抛错换成三态，
 * 额外用索引里的逐篇 mtime 给出「落后几篇」。
 */
export async function indexStatus(root: string, dbPath?: string): Promise<IndexStatus> {
  const abs = resolve(root);
  const target = dbPath || indexDbPath(abs);
  const base: IndexStatus = { root: abs, db: target, state: "missing", indexed: 0, scanned: 0, added: 0, removed: 0, changed: 0, contentOnly: false };
  const snap = await readSnapshot(target);
  if (!snap || snap.schema !== SCHEMA_VERSION) return base;
  const scan = scanRoot(abs);
  if (snap.root !== abs) return { ...base, state: "foreign", indexed: snap.docs, scanned: scan.docs };
  const disk = new Map(walk(abs).map((f) => {
    const rel = relative(abs, f);
    // 与建索引时同口径：秒级 mtime
    return [rel, Math.floor(statSync(f).mtimeMs / 1000)] as [string, number];
  }));
  const recorded = new Set(snap.rows.map((r) => r.path));
  let added = 0, removed = 0, changed = 0;
  for (const p of disk.keys()) if (!recorded.has(p)) added++;
  for (const r of snap.rows) {
    if (!disk.has(r.path)) removed++;
    else if (disk.get(r.path) !== r.mtime) changed++;
  }
  const stale = snap.docs !== scan.docs || snap.fingerprint !== scan.fingerprint;
  return {
    ...base, state: stale ? "stale" : "ok",
    indexed: snap.docs, scanned: scan.docs, added, removed, changed,
    contentOnly: stale && added + removed + changed === 0,
  };
}

export interface Hit { path: string; title: string; snippet: string }

export interface Hit { path: string; title: string; snippet: string; score?: number; why?: string }

function queryTerms(q: string): string[] {
  const out = new Set<string>();
  const parts = q.split(/[\s,，。.;；:：!?！？、|/]+/).map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    out.add(p);
    // CJK 长词切 2/3 字，避免把“评审请求消息模板”当成一个不可匹配的整串
    for (const run of p.match(/[\u4e00-\u9fff]+/g) || []) {
      const chars = [...run];
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(""));
      }
    }
  }
  return [...out].slice(0, 24);
}

function ftsOr(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export async function search(root: string, query: string, dbPath?: string, limit = 10): Promise<Hit[]> {
  const q = query.trim();
  if (!q) return [];
  const path = await assertIndex(root, dbPath);
  const db = await openDb(path, { readonly: true });
  try {
    const out: Hit[] = [];
    const seen = new Set<string>();
    const add = (rows: any[], why: string) => {
      for (const r of rows) {
        const p = String(r.path || "");
        if (!p || seen.has(p) || out.length >= limit) continue;
        seen.add(p);
        out.push({ path: p, title: r.title, snippet: String(r.snip || "").replace(/\n/g, " "), score: r.score, why });
      }
    };

    // 1) ID 直通：R30.5 / V1 等精确 ID，不依赖分词
    if (/^[RVS]\d+(?:\.\d+)*$/i.test(q)) {
      add(db.all<any>(
        "SELECT path,title,substr(body, max(1, instr(body, ?) - 40), 180) AS snip FROM docs " +
        "WHERE body LIKE ? OR title LIKE ? ORDER BY CASE WHEN body LIKE ? THEN 0 ELSE 1 END, tokens ASC LIMIT ?",
        [q, `%${q}%`, `%${q}%`, `%### %${q}.%`, limit],
      ), "id");
      return out;
    }

    // 1b) 查询里夹带 ID（如 “R30.5 评审…”）：ID 精确命中优先，但继续合并语义结果
    const idToken = q.match(/\b[RVS]\d+(?:\.\d+)*\b/i)?.[0];
    if (idToken) {
      add(db.all<any>(
        "SELECT path,title,substr(body, max(1, instr(body, ?) - 40), 180) AS snip FROM docs " +
        "WHERE body LIKE ? OR title LIKE ? ORDER BY CASE WHEN body LIKE ? THEN 0 ELSE 1 END, tokens ASC LIMIT ?",
        [idToken, `%${idToken}%`, `%${idToken}%`, `%### %${idToken}.%`, limit],
      ), "id-token");
    }

    const terms = queryTerms(q);
    // 2) 整句 phrase（英文/短词优先）
    if ([...q].length >= 3) {
      const phrase = '"' + q.replace(/"/g, "") + '"';
      try {
        add(db.all<any>(
          "SELECT path,title,snippet(docs_fts, 2, '[', ']', '…', 12) AS snip FROM docs_fts " +
          "WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts, 0.0, 5.0, 1.0) + CASE WHEN path LIKE 'rules/%' THEN -0.3 ELSE 0 END LIMIT ?",
          [phrase, limit],
        ), "phrase");
      } catch { /* fall through */ }
    }
    // 3) term OR（多词/长中文退阶）；FTS 对 <3 字可能无结果，继续 LIKE
    if (out.length < limit && terms.length > 1) {
      try {
        add(db.all<any>(
          "SELECT path,title,snippet(docs_fts, 2, '[', ']', '…', 12) AS snip FROM docs_fts " +
          "WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts, 0.0, 5.0, 1.0) + CASE WHEN path LIKE 'rules/%' THEN -0.3 ELSE 0 END LIMIT ?",
          [ftsOr(terms), limit],
        ), "terms");
      } catch { /* fall through */ }
    }
    // 4) LIKE 退阶：按 title/body 命中权重排序，不再按文档长度
    if (out.length < limit) {
      const where = terms.map(() => "(title LIKE ? OR body LIKE ?)").join(" OR ");
      const params: any[] = [];
      for (const t of terms) params.push(`%${t}%`, `%${t}%`);
      const score = terms.map(() => "(CASE WHEN title LIKE ? THEN 4 ELSE 0 END + CASE WHEN body LIKE ? THEN 1 ELSE 0 END)").join(" + ") + " + CASE WHEN path LIKE 'rules/%' THEN 2 ELSE 0 END";
      const scoreParams: any[] = [];
      for (const t of terms) scoreParams.push(`%${t}%`, `%${t}%`);
      add(db.all<any>(
        `SELECT path,title,substr(body, max(1, instr(body, ?) - 40), 180) AS snip, (${score}) AS score ` +
        "FROM docs WHERE " + where + " ORDER BY score DESC, tokens ASC LIMIT ?",
        [terms[0] || q, ...scoreParams, ...params, limit],
      ), "like");
    }
    return out;
  } finally {
    db.close();
  }
}

export interface LintResult {
  root: string;
  docs: number;
  bytes: number;
  tokens_est: number;
  index_covered: number;
  index_missing: string[];
  review_missing: number;
  review_missing_paths: string[];
  review_overdue: { path: string; review_by: string }[];
  stale: { path: string; age_days: number }[];
  broken_links: { path: string; link: string }[];
  biggest: { path: string; tokens: number }[];
}

export async function lint(root: string, dbPath?: string, staleDays = 180): Promise<LintResult> {
  const abs = resolve(root);
  const path = await assertIndex(root, dbPath);
  const db = await openDb(path, { readonly: true });
  const rows = db.all<any>("SELECT path, bytes, tokens, mtime, review_by FROM docs");
  db.close();
  const indexFile = join(abs, "index.md");
  const indexText = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  const today = new Date().toISOString().slice(0, 10);
  const missing: string[] = [], overdue: any[] = [], stale: any[] = [], broken: any[] = [];
  for (const r of rows) {
    const isIndex = r.path === "index.md";
    if (!isIndex && indexText && !indexText.includes(basename(r.path))) missing.push(r.path);
    if (r.review_by) {
      if (r.review_by < today) overdue.push({ path: r.path, review_by: r.review_by });
    } else if (Date.now() / 1000 - r.mtime > staleDays * 86400) {
      stale.push({ path: r.path, age_days: Math.floor((Date.now() / 1000 - r.mtime) / 86400) });
    }
    const full = join(abs, r.path);
    const body = existsSync(full) ? readFileSync(full, "utf8") : "";
    for (const m of body.matchAll(LINK)) {
      const url = m[1];
      if (/^(https?:|mailto:|#|\/)/.test(url) || url.includes("<") || url === "URL") continue;
      const target = normalize(join(dirname(full), url.split("#")[0]));
      if (!existsSync(target)) broken.push({ path: r.path, link: url });
    }
  }
  return {
    root: abs,
    docs: rows.length,
    bytes: rows.reduce((a, r) => a + r.bytes, 0),
    tokens_est: rows.reduce((a, r) => a + r.tokens, 0),
    index_covered: indexText ? rows.length - missing.length : 0,
    index_missing: missing,
    review_missing: rows.filter((r) => !r.review_by).length,
    review_missing_paths: rows.filter((r) => !r.review_by).map((r) => r.path),
    review_overdue: overdue,
    stale,
    broken_links: broken,
    biggest: [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((r) => ({ path: r.path, tokens: r.tokens })),
  };
}

export function getDoc(root: string, rel: string, section?: string): string {
  const abs = resolve(root);
  const full = normalize(join(abs, rel));
  if (full !== abs && !full.startsWith(abs + sep)) throw new Error("path escapes root");
  const text = readFileSync(full, "utf8");
  if (!section) return text;
  const out: string[] = [];
  let on = false, startLevel = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) {
      const level = line.length - line.replace(/^#+/, "").length;
      if (on && level <= startLevel) break;
      if (!on && line.includes(section)) { on = true; startLevel = level; }
    }
    if (on) out.push(line);
  }
  return out.join("\n");
}

export * from "./path.ts";
