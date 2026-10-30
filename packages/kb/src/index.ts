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

export function defaultDb(root: string): string {
  const key = createHash("sha1").update(resolve(root)).digest("hex").slice(0, 16);
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, key + ".db");
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

async function readMeta(path: string): Promise<IndexMeta | null> {
  if (!existsSync(path)) return null;
  const db = await openDb(path, { readonly: true });
  try {
    const rows = db.all<any>("SELECT key, value FROM meta");
    const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    if (!m.has("schema") || !m.has("docs")) return null;
    return {
      docs: Number(m.get("docs") || 0), max_mtime_ms: Number(m.get("max_mtime_ms") || 0),
      fingerprint: m.get("fingerprint") || "", tokenizer: m.get("tokenizer") || "unknown",
      root: m.get("root") || "", schema: Number(m.get("schema") || 0),
    };
  } catch {
    return null;
  } finally { db.close(); }
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

export interface Hit { path: string; title: string; snippet: string }

export async function search(root: string, query: string, dbPath?: string, limit = 10): Promise<Hit[]> {
  const q = query.trim();
  if (!q) return [];
  const path = await assertIndex(root, dbPath);
  const db = await openDb(path, { readonly: true });
  try {
    if ([...q].length >= 3) {
      const phrase = '"' + q.replace(/"/g, "") + '"';
      try {
        const rows = db.all<any>(
          "SELECT path, title, snippet(docs_fts, 2, '[', ']', '…', 12) AS snip FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?",
          [phrase, limit],
        );
        if (rows.length) return rows.map((r) => ({ path: r.path, title: r.title, snippet: String(r.snip || "").replace(/\n/g, " ") }));
      } catch { /* fall through */ }
    }
    const rows = db.all<any>(
      "SELECT path, title, substr(body, max(1, instr(body, ?) - 40), 160) AS snip FROM docs WHERE body LIKE ? ORDER BY tokens DESC LIMIT ?",
      [q, "%" + q + "%", limit],
    );
    return rows.map((r) => ({ path: r.path, title: r.title, snippet: String(r.snip || "").replace(/\n/g, " ") }));
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
