#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const file = process.argv[2];
const seed = Number(process.argv[3] || 11);
const rows: any[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bad = /headless|Implement this task in the repo|Repo: \/tmp\/team|verify-ws|redteam-ws|只回答|YAN-OK|mock|Return only JSON|You are teammate|team-data/i;
const keep = rows.filter((r) => !bad.test(String(r.summary || "")));

function rng(a: number) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(seed);
for (let i = keep.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [keep[i], keep[j]] = [keep[j], keep[i]]; }
console.error(`# total=${rows.length} keep=${keep.length} seed=${seed}`);
for (const r of keep.slice(0, 20)) console.log(`${r.episode_id}\t${r.source}\t${String(r.summary || "").slice(0, 80)}`);
