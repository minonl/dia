import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { freeze } from "./freeze.ts";

const DATA = process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");

export interface AuditEvent {
  ts: string;
  session: string;
  agent?: string | null;
  tool: string;
  params_hash: string;
  decision: "allow" | "deny" | "waive";
  waiver_id?: string;
  risk?: number;
  exit?: number;
  redline?: boolean;
  note?: string;
}

export const WEIGHTS = { deny: 2, envelope: 4, unknown: 3, mismatch: 10 };
export const WARN_AT = 3;
export const FREEZE_AT = 10;

export function auditFile(): string {
  return join(DATA, "audit", "audit.jsonl");
}

export function append(ev: Omit<AuditEvent, "ts" | "params_hash"> & { params?: unknown; params_hash?: string }): AuditEvent {
  const file = auditFile();
  mkdirSync(join(DATA, "audit"), { recursive: true });
  const { params, ...rest } = ev;
  const params_hash = ev.params_hash || createHash("sha256").update(JSON.stringify(params ?? null)).digest("hex").slice(0, 16);
  const full: AuditEvent = { ts: new Date().toISOString(), params_hash, ...rest } as AuditEvent;
  appendFileSync(file, JSON.stringify(full) + "\n");
  if (full.redline) {
    freeze({ reason: `redline: ${full.tool} in ${full.session}`, by: "auto", session: full.session });
  } else {
    const s = score(full.session);
    if (s.score >= FREEZE_AT) freeze({ reason: `security_score ${s.score} >= ${FREEZE_AT}`, by: "auto", session: full.session });
  }
  return full;
}

function rows(): AuditEvent[] {
  const file = auditFile();
  if (!existsSync(file)) return [];
  const out: AuditEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function score(session: string) {
  let score = 0;
  const reasons: string[] = [];
  for (const r of rows().filter((x) => x.session === session)) {
    if (r.decision === "deny") { score += WEIGHTS.deny; reasons.push("deny:+2"); }
    if (r.decision === "waive") { score += r.risk ?? 1; reasons.push(`waive:+${r.risk ?? 1}`); }
    if (r.note === "envelope") { score += WEIGHTS.envelope; reasons.push("envelope:+4"); }
    if (r.note === "unknown-tool") { score += WEIGHTS.unknown; reasons.push("unknown:+3"); }
    if (r.note === "mismatch") { score += WEIGHTS.mismatch; reasons.push("mismatch:+10"); }
    if (r.redline) { score += FREEZE_AT; reasons.push("redline:+10"); }
  }
  return { session, score, reasons, level: score >= FREEZE_AT ? "freeze" : score >= WARN_AT ? "warn" : "ok" };
}

export function verify(session: string, expectedCalls: number) {
  const n = rows().filter((r) => r.session === session).length;
  const ok = n === expectedCalls;
  return {
    session, audit_rows: n, expected_calls: expectedCalls, ok,
    gap: Math.max(0, expectedCalls - n),
    extra: Math.max(0, n - expectedCalls),
    level: ok ? "ok" : "mismatch",
  };
}

export function tail(n = 20): AuditEvent[] {
  return rows().slice(-n);
}
