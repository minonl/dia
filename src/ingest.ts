import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { redact } from "./redact.ts";
import { openDb } from "./sqlite.ts";
import * as paths from "./paths.ts";

const CACHE = join(homedir(), ".cache", "dia", "ingest");
const DATA = paths.ingestDir();

export interface Episode {
  schema_v: 1;
  episode_id: string;
  source: "dsh" | "opencode";
  domain: string;
  agent: string | null;
  workspace: string;
  project: string | null;       // hash(project_id)
  workspace_id: string | null;  // opencode workspace（可能为 null）
  directory_hash: string;       // hash(directory)
  path_hash: string;            // hash(path)
  ts_start: string;
  ts_end: string;
  turns: number;
  tools: { name: string; count: number; ok: number }[];
  summary: string;
  raw_ref: string;
}

export interface IngestOpts {
  sources?: ("dsh" | "opencode")[];
  domain?: string;
  since?: string;
  full?: boolean;
  limit?: number;
  dryRun?: boolean;
  sessionsRoot?: string;
  opencodeDb?: string;
  outDir?: string;
  cacheDir?: string;
  project?: string;             // 只采某个 opencode project（默认全部）
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string, n = 240) => s.replace(/\s+/g, " ").trim().slice(0, n);

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  }
  if (content && typeof content === "object") return content.text ?? "";
  return "";
}

function walkDsh(root: string): string[] {
  const out: string[] = [];
  (function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name === "session.v4.jsonl.zstd") out.push(p);
    }
  })(root);
  return out.sort();
}

export function parseDsh(file: string, domain: string): Episode | null {
  const raw = zstdDecompressSync(readFileSync(file)).toString("utf8");
  let sessionId = basename(dirname(file));
  let workspace = "";
  let start = 0, end = 0, turns = 0;
  const calls: { name: string; ok: boolean }[] = [];
  const results: boolean[] = [];
  let summary = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "session") {
      sessionId = d.id || sessionId;
      workspace = d.cwd || "";
      start = start || Number(d.createdAt || 0);
    }
    const t = Number(d.time || 0);
    if (t) { start = start || t; end = Math.max(end, t); }
    const data = d.data || {};
    if (d.type === "user/message") {
      turns++;
      if (!summary) summary = textOf(data.content);
    } else if (d.type === "tool/call") {
      calls.push({ name: String(data.name || "unknown"), ok: false });
    } else if (d.type === "tool/result") {
      const msg = data.message;
      const failed = !!msg && typeof msg === "object" && (msg.ok === false || !!msg.error || msg.isError === true);
      results.push(!failed);
    }
  }
  if (!turns && !calls.length) return null;
  calls.forEach((c, i) => { c.ok = results[i] === true; });
  const r = redact(summary);
  const agg = new Map<string, { name: string; count: number; ok: number }>();
  for (const c of calls) {
    const k = agg.get(c.name) || { name: c.name, count: 0, ok: 0 };
    k.count++;
    if (c.ok) k.ok++;
    agg.set(c.name, k);
  }
  return {
    schema_v: 1,
    episode_id: sha(`dsh|${sessionId}|${start}|${end}|${turns}`),
    source: "dsh",
    domain,
    agent: null,
    workspace: workspace ? sha(workspace).slice(0, 12) : "",
    project: null,
    workspace_id: null,
    directory_hash: "",
    path_hash: "",
    ts_start: start ? iso(start) : "",
    ts_end: end ? iso(end) : "",
    turns,
    tools: [...agg.values()].sort((a, b) => b.count - a.count),
    summary: clip(r.text),
    raw_ref: `dsh:${sessionId}`,
  };
}

export async function readOpencode(dbPath: string, domain: string, project?: string): Promise<Episode[]> {
  const db = await openDb(dbPath, { readonly: true });
  try {
    let sessions: any[];
    try {
      const where = project ? " AND project_id = ?" : "";
      const params = project ? [project] : [];
      sessions = db.all<any>(
        "SELECT id, title, directory, agent, time_created, time_updated, project_id, path, workspace_id" +
        " FROM session WHERE parent_id IS NULL" + where + " ORDER BY time_updated",
        params,
      );
    } catch {
      // 老库没有 project_id/path/workspace_id：退回基础列，不阻塞采集
      sessions = db.all<any>(
        "SELECT id, title, directory, agent, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated",
      );
    }
    const out: Episode[] = [];
    for (const s of sessions) {
      const turnsRow = db.all<any>(
        "SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND json_extract(data,'$.role')='user'",
        [s.id],
      )[0];
      const parts = db.all<any>(
        "SELECT data FROM part WHERE session_id = ? AND json_extract(data,'$.type')='tool'",
        [s.id],
      );
      const agg = new Map<string, { name: string; count: number; ok: number }>();
      for (const p of parts) {
        let d: any = {};
        try { d = JSON.parse(p.data); } catch {}
        const name = String(d.tool || "unknown");
        const k = agg.get(name) || { name, count: 0, ok: 0 };
        k.count++;
        if (d?.state?.status === "completed") k.ok++;
        agg.set(name, k);
      }
      const title = redact(String(s.title || ""));
      out.push({
        schema_v: 1,
        episode_id: sha(`opencode|${s.id}|${s.time_created}|${s.time_updated}|${turnsRow.n}`),
        source: "opencode",
        domain,
        agent: s.agent ? String(s.agent) : null,
        workspace: s.directory ? sha(String(s.directory)).slice(0, 12) : "",
        project: s.project_id ? sha(String(s.project_id)).slice(0, 12) : null,
        workspace_id: s.workspace_id ? String(s.workspace_id) : null,
        directory_hash: s.directory ? sha(String(s.directory)).slice(0, 12) : "",
        path_hash: s.path ? sha(String(s.path)).slice(0, 12) : "",
        ts_start: iso(Number(s.time_created)),
        ts_end: iso(Number(s.time_updated)),
        turns: Number(turnsRow.n || 0),
        tools: [...agg.values()].sort((a, b) => b.count - a.count),
        summary: clip(title.text),
        raw_ref: `opencode:${s.id}`,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

function loadState(cacheDir?: string): any {
  const p = join(cacheDir || CACHE, "state.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

function seenSet(file: string): Set<string> {
  const set = new Set<string>();
  if (!existsSync(file)) return set;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { set.add(JSON.parse(line).episode_id); } catch {}
  }
  return set;
}

export async function ingest(opts: IngestOpts = {}) {
  const domain = opts.domain || "local";
  const sources = opts.sources || ["dsh", "opencode"];
  const outDir = opts.outDir || join(DATA, "corpus");
  const cacheDir = opts.cacheDir || CACHE;
  const state = loadState(cacheDir);
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const result = { scanned: 0, skipped: 0, written: 0, candidates: 0, redactions: {} as Record<string, number>, episodes: [] as Episode[] };

  if (!opts.dryRun) mkdirSync(outDir, { recursive: true });
  const epFile = join(outDir, "episodes.jsonl");
  const candFile = join(outDir, "candidates.jsonl");
  const seen = opts.dryRun ? new Set<string>() : seenSet(epFile);

  let episodes: Episode[] = [];
  if (sources.includes("dsh")) {
    const root = opts.sessionsRoot || join(homedir(), ".dsh", "sessions");
    if (existsSync(root)) {
      const cutoff = opts.full ? 0 : sinceMs ?? Number(state.dsh?.lastMtime || 0);
      for (const file of walkDsh(root)) {
        const mtime = Math.floor(statSync(file).mtimeMs);
        result.scanned++;
        if (mtime < cutoff) { result.skipped++; continue; }
        const ep = parseDsh(file, domain);
        if (ep) episodes.push(ep);
        state.dsh = { lastMtime: Math.max(Number(state.dsh?.lastMtime || 0), mtime) };
      }
    }
  }
  if (sources.includes("opencode")) {
    const dbPath = opts.opencodeDb || join(homedir(), ".local", "share", "opencode", "opencode.db");
    if (existsSync(dbPath)) {
      const cutoff = opts.full ? 0 : sinceMs ?? Number(state.opencode?.lastUpdated || 0);
      const all = await readOpencode(dbPath, domain, opts.project);
      result.scanned += all.length;
      for (const ep of all) {
        if (Date.parse(ep.ts_end) < cutoff) { result.skipped++; continue; }
        episodes.push(ep);
        state.opencode = { lastUpdated: Math.max(Number(state.opencode?.lastUpdated || 0), Date.parse(ep.ts_end)) };
      }
    }
  }

  episodes.sort((a, b) => a.ts_start.localeCompare(b.ts_start));
  if (opts.limit) episodes = episodes.slice(0, opts.limit);
  for (const ep of episodes) {
    if (seen.has(ep.episode_id)) { result.skipped++; continue; }
    result.written++;
    result.episodes.push(ep);
    const r = redact(ep.summary);
    for (const [k, v] of Object.entries(r.hits)) result.redactions[k] = (result.redactions[k] || 0) + v;
    if (opts.dryRun) continue;
    appendFileSync(epFile, JSON.stringify(ep) + "\n");
    seen.add(ep.episode_id);
    const totalTools = ep.tools.reduce((a, t) => a + t.count, 0);
    const hasFailure = ep.tools.some((t) => t.ok < t.count);
    const keyword = /修复|重试|失败|排查|坑|迁移|重构|回滚/.test(ep.summary);
    if (totalTools >= 3 && (hasFailure || keyword)) {
      appendFileSync(candFile, JSON.stringify({ episode_id: ep.episode_id, ts: ep.ts_end, source: ep.source, turns: ep.turns, tools: totalTools, reason: hasFailure ? "retry" : "keyword" }) + "\n");
      result.candidates++;
    }
  }
  if (!opts.dryRun) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "state.json"), JSON.stringify(state, null, 1));
  }
  return result;
}

export interface RepoUpdate { hash: string; time: string; subject: string; files: string[] }

export function readGitUpdates(repo: string, since: string, limit = 200): RepoUpdate[] {
  const raw = execFileSync("git", ["-C", repo, "log", `--since=${since}`, "--pretty=format:\u0001%H\u0002%cI\u0002%s", "--name-only"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out: RepoUpdate[] = [];
  for (const block of raw.split("\u0001").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [hash, time, subject] = head.split("\u0002");
    const files = rest.map((l) => l.trim()).filter(Boolean).slice(0, 50);
    out.push({ hash, time, subject: redact(subject || "").text, files });
    if (out.length >= limit) break;
  }
  return out;
}
