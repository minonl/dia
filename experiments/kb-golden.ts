#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const src = process.argv[2];
const out = process.argv[3] || join(homedir(), ".yan-agent", "observability", "kb-golden-20.json");
const rows: any[] = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by = new Map<string, any[]>();
for (const r of rows) {
  if (!r.query && !(r.scenes || []).length) continue;
  const m = r.mode || "query";
  if (!by.has(m)) by.set(m, []);
  by.get(m)!.push(r);
}
function rng(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(30);
const wanted: Record<string, number> = { query: 8, scene: 6, rule: 3, auto: 2, list: 1 };
const seen = new Set<string>();
const picked: any[] = [];
for (const [mode, n] of Object.entries(wanted)) {
  const pool = [...(by.get(mode) || [])];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const r of pool) {
    const k = `${r.mode}|${r.query}|${(r.scenes || []).join(",")}`;
    if (seen.has(k)) continue;
    seen.add(k); picked.push(r);
    if (picked.length >= Object.values(wanted).slice(0, Object.keys(wanted).indexOf(mode) + 1).reduce((a, b) => a + b, 0)) break;
  }
}
for (const r of rows) {
  if (picked.length >= 20) break;
  const k = `${r.mode}|${r.query}|${(r.scenes || []).join(",")}`;
  if (!seen.has(k) && (r.query || (r.scenes || []).length)) { seen.add(k); picked.push(r); }
}
const items = picked.slice(0, 20).map((r) => ({ ts: r.ts, mode: r.mode, query: r.query, scenes: r.scenes || [], hits: r.hits || [], zeroHit: !!r.zeroHit, exitCode: r.exitCode }));
const data = { schema: 1, source: src.split("/").pop(), seed: 30, counts: Object.fromEntries(Object.keys(wanted).map((m) => [m, items.filter((x) => x.mode === m).length])), query_hash: createHash("sha256").update(items.map((x) => x.query || "").join("\n")).digest("hex"), items };
writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
console.log(`wrote ${out} n=${items.length} counts=${JSON.stringify(data.counts)} hash=${data.query_hash.slice(0, 12)}`);
