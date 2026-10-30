import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA = process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");

export interface CallRecord {
  run_id: string;
  session: string;
  tool: string;
  params_hash: string;
  ts: string;
  duration_ms: number;
  exit: number;
  cwd?: string;
}

export function callsFile(): string {
  return join(DATA, "runtime", "calls.jsonl");
}

export function allCalls(): CallRecord[] {
  const f = callsFile();
  if (!existsSync(f)) return [];
  const out: CallRecord[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function countCalls(session: string): number {
  return allCalls().filter((c) => c.session === session).length;
}

export function lastCall(session: string): CallRecord | null {
  const rows = allCalls().filter((c) => c.session === session);
  return rows.length ? rows[rows.length - 1] : null;
}

export function lastFailure(session: string): CallRecord | null {
  const rows = allCalls().filter((c) => c.session === session && c.exit !== 0);
  return rows.length ? rows[rows.length - 1] : null;
}
