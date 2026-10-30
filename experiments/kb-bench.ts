#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const calls = process.argv[2];
const n = Number(process.argv[3] || 100);
const out = process.argv[4] || join(homedir(), ".yan-agent", "observability", "kb-bench-100.json");
const yan = join(homedir(), ".yan-agent", "repos", "yan-agent");
const root = join(yan, "core", "knowledge");
const dia = process.env.DIA_BIN || join(homedir(), ".local", "bin", "dia");
const rows: any[] = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.mode === "query" && r.query);
function rng(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(32);
for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
const sample = rows.slice(0, n);
spawnSync(dia, ["kb", "index", "--root", root], { encoding: "utf8" });
const stats = { total: 0, answerable: 0, old_hits: 0, recall_hits: 0, zero: 0, top1_equal: 0, top1_in_old: 0, old_ms: [] as number[], dia_ms: [] as number[] };
const details: any[] = [];
for (const it of sample) {
  const q = it.query;
  let t = performance.now();
  const old = JSON.parse(spawnSync("yan-kb", [q, "--json"], { cwd: yan, encoding: "utf8" }).stdout || "{}");
  stats.old_ms.push(performance.now() - t);
  t = performance.now();
  const neu = JSON.parse(spawnSync(dia, ["kb", "query", q, "--root", root, "--json"], { encoding: "utf8" }).stdout || "[]");
  stats.dia_ms.push(performance.now() - t);
  const oldPaths = new Set((old.hits || []).map((x: any) => x.file).filter(Boolean));
  const newPaths = new Set(neu.map((x: any) => x.path).filter(Boolean));
  const oldTop = old.hits?.[0]?.file ?? null; const newTop = neu[0]?.path ?? null;
  stats.total++; stats.old_hits += oldPaths.size; stats.recall_hits += [...oldPaths].filter((x) => newPaths.has(x)).length;
  if (oldPaths.size && !newPaths.size) stats.zero++;
  if (oldPaths.size) stats.answerable++;
  if (oldTop === newTop) stats.top1_equal++;
  if (oldPaths.has(newTop)) stats.top1_in_old++;
  details.push({ query_hash: createHash("sha256").update(q).digest("hex").slice(0, 16), old_hits: oldPaths.size, new_hits: newPaths.size, miss: [...oldPaths].filter((x) => !newPaths.has(x)), old_top: oldTop, new_top: newTop });
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.floor(xs.length * 0.95) - 1)] || 0;
const pct = (a: number, b: number) => b ? Math.round(a / b * 10000) / 100 : 0;
const summary = { schema: 1, sample: sample.length, answerable: stats.answerable, rule_recall: `${stats.recall_hits}/${stats.old_hits}`, recall_pct: pct(stats.recall_hits, stats.old_hits), answerable_zero: stats.zero, top1_equal: stats.top1_equal, top1_equal_pct: pct(stats.top1_equal, stats.answerable), top1_in_old: stats.top1_in_old, top1_in_old_pct: pct(stats.top1_in_old, stats.answerable), old_p50_ms: Math.round(stats.old_ms.sort((a,b)=>a-b)[Math.floor(stats.old_ms.length/2)]), old_p95_ms: Math.round(p95(stats.old_ms)), dia_p50_ms: Math.round(stats.dia_ms.sort((a,b)=>a-b)[Math.floor(stats.dia_ms.length/2)]), dia_p95_ms: Math.round(p95(stats.dia_ms)), query_hash: createHash("sha256").update(sample.map((x) => x.query).join("\n")).digest("hex") };
writeFileSync(out, JSON.stringify({ summary, details }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
