import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { freeze } from "./freeze.ts";

const DATA = process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");

export interface AuditEvent {
  /** 1-based position in the append-only log (added with the hash chain). */
  seq?: number;
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
  /** hash of the previous chained row (GENESIS for the first chained row). */
  prev_hash?: string;
  /** truncated sha256 over canonical(record without `hash`) + prev_hash. */
  hash?: string;
}

export const WEIGHTS = { deny: 2, envelope: 4, unknown: 3, mismatch: 10 };
export const WARN_AT = 3;
export const FREEZE_AT = 10;

/** Length of the truncated chain hash (hex chars). */
export const HASH_LEN = 16;
/** prev_hash of the first chained row. */
export const GENESIS = "0".repeat(HASH_LEN);

export function auditDir(): string {
  return join(DATA, "audit");
}

export function auditFile(): string {
  return join(auditDir(), "audit.jsonl");
}

/**
 * External chain head anchor: last seq/hash + row count, rewritten atomically after each
 * append. It lives next to the log, so it raises detectability of a truncated/rolled-back
 * tail rather than making the log tamper-*proof* — an attacker who can rewrite both the
 * log and this anchor is out of scope (use an off-box checkpoint for that).
 */
export function headFile(): string {
  return join(auditDir(), "head.json");
}

/** Serialisation lock (mkdir-based; see acquireLock). */
function lockDir(): string {
  return join(auditDir(), ".lock");
}

/** Recorded chain head (kept outside the log so a truncated log is still detectable). */
export interface ChainHead {
  last_seq: number;
  last_hash: string;
  row_count: number;
  updated_at?: string;
}

type HeadRead =
  | { state: "ok"; head: ChainHead }
  | { state: "missing" }
  | { state: "corrupt"; error: string };

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep usable from append() (which must stay sync for callers). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(sleepCell, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy fallback */ }
  }
}

/**
 * Exclusive writer lock over the audit log.
 *
 * mkdir is atomic on every filesystem we target (O_EXCL semantics for a directory),
 * so "created the lock dir" means "nobody else is appending". Stale locks left by a
 * killed process are reclaimed after DIA_AUDIT_LOCK_STALE_MS (and unconditionally after
 * 6x that, so a zombie holder cannot wedge the log forever); acquisition gives up after
 * DIA_AUDIT_LOCK_TIMEOUT_MS instead of blocking forever — fail-closed: the caller reports
 * the append as failed rather than forking the chain.
 */
function acquireLock(): () => void {
  mkdirSync(auditDir(), { recursive: true });
  const dir = lockDir();
  const timeout = envMs("DIA_AUDIT_LOCK_TIMEOUT_MS", 5000);
  const stale = envMs("DIA_AUDIT_LOCK_STALE_MS", 10000);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  let wait = 1;
  for (;;) {
    try {
      mkdirSync(dir);
      try { writeFileSync(join(dir, "owner"), token + "\n"); } catch {}
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // only drop the lock we own (a stale reclaimer may have replaced it)
        try {
          if (readFileSync(join(dir, "owner"), "utf8").trim() !== token) return;
        } catch { return; }
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      };
    } catch (e) {
      if ((e as { code?: string })?.code !== "EEXIST") throw e;
      let ageMs: number | null = null;
      try { ageMs = Date.now() - statSync(dir).mtimeMs; } catch { ageMs = null; }
      const abandoned = ageMs !== null && ageMs > stale && (holderAlive(dir) !== true || ageMs > stale * 6);
      if (abandoned) {
        // holder crashed (or is wedged far beyond any real append) — reclaim and retry
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() - started >= timeout) {
        throw new Error(`audit lock timeout after ${timeout}ms (${dir}); refusing to append un-serialised`);
      }
      sleepSync(wait);
      wait = Math.min(wait * 2, 50);
    }
  }
}

/** Is the process recorded in the lock dir still running? (null = unknown) */
function holderAlive(dir: string): boolean | null {
  try {
    // owner 格式是 `<pid>-<ts>-<rand>`（见 acquireLock），只取第一段
    const pid = Number(readFileSync(join(dir, "owner"), "utf8").trim().split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: string })?.code === "EPERM";
    }
  } catch {
    return null;
  }
}

function readHead(): HeadRead {
  const file = headFile();
  if (!existsSync(file)) return { state: "missing" };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { state: "corrupt", error: `unreadable or invalid json: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "corrupt", error: "bad shape" };
  const { last_seq: seq, last_hash: hash, row_count: count } = parsed;
  if (!Number.isInteger(seq) || seq < 0) return { state: "corrupt", error: "bad last_seq" };
  if (typeof hash !== "string" || !new RegExp(`^[0-9a-f]{${HASH_LEN}}$`).test(hash)) return { state: "corrupt", error: "bad last_hash" };
  if (!Number.isInteger(count) || count < 0) return { state: "corrupt", error: "bad row_count" };
  return {
    state: "ok",
    head: {
      last_seq: seq, last_hash: hash, row_count: count,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
    },
  };
}

let headTmpCounter = 0;

/** Atomic anchor write: temp file + rename, so readers never see a half-written head. */
function writeHead(head: ChainHead): void {
  const file = headFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++headTmpCounter}.tmp`;
  writeFileSync(tmp, JSON.stringify(head) + "\n");
  renameSync(tmp, file);
}

/** Deterministic serialisation (sorted keys, undefined dropped) for hashing. */
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

/** hash = sha256(canonical(record without `hash`) + prev_hash), truncated. */
export function hashEvent(rec: Omit<AuditEvent, "hash">, prev_hash: string): string {
  const { hash: _drop, ...rest } = rec as AuditEvent;
  return createHash("sha256").update(canonical(rest) + ":" + prev_hash).digest("hex").slice(0, HASH_LEN);
}

export function append(ev: Omit<AuditEvent, "ts" | "params_hash"> & { params?: unknown; params_hash?: string }): AuditEvent {
  const file = auditFile();
  mkdirSync(auditDir(), { recursive: true });
  const { params, params_hash: _ph, seq: _seq, hash: _hash, prev_hash: _prev, ...rest } = ev;
  const params_hash = ev.params_hash || createHash("sha256").update(JSON.stringify(params ?? null)).digest("hex").slice(0, 16);
  let full: AuditEvent;
  // Reading the tail, computing seq/prev_hash, appending and recording the head anchor
  // all happen under the exclusive lock, so concurrent writers can no longer read the
  // same last row and fork the chain.
  const release = acquireLock();
  try {
    const last = lastRecord();
    const anchor = readHead();
    if (anchor.state === "corrupt") throw new Error(`E_AUDIT_CHAIN: 锚点损坏（${anchor.error}）；拒绝追加，先人工核查 ${headFile()}`);
    // 锚点被删但日志已有链：不能拿当前尾部重建（会把截断证据抹掉）→ fail-closed
    if (anchor.state === "missing" && last.hash) throw new Error(`E_AUDIT_CHAIN: 锚点缺失但日志已有链；拒绝追加，先人工核查 ${headFile()}`);
    if (anchor.state === "ok") {
      const a = anchor.head;
      const tailSeq = last.seq ?? 0, tailHash = last.hash ?? GENESIS;
      if (a.row_count !== last.count || a.last_seq !== tailSeq || a.last_hash !== tailHash) {
        throw new Error(`E_AUDIT_CHAIN: 日志尾部与锚点不一致（疑似删行/篡改：anchor ${a.row_count}/${a.last_seq} vs log ${last.count}/${tailSeq}）；拒绝追加`);
      }
    }
    const prev_hash = last.hash ?? GENESIS;
    const seq = (last.seq ?? last.count) + 1;
    const base: AuditEvent = { seq, ts: new Date().toISOString(), params_hash, ...rest } as AuditEvent;
    full = { ...base, prev_hash };
    full.hash = hashEvent(full, prev_hash);
    appendFileSync(file, JSON.stringify(full) + "\n");
    writeHead({
      last_seq: seq,
      last_hash: full.hash,
      row_count: last.count + 1,
      updated_at: full.ts,
    });
  } finally {
    release();
  }
  if (full.redline) {
    freeze({ reason: `redline: ${full.tool} in ${full.session}`, by: "auto", session: full.session });
  } else {
    const s = score(full.session);
    if (s.score >= FREEZE_AT) freeze({ reason: `security_score ${s.score} >= ${FREEZE_AT}`, by: "auto", session: full.session });
  }
  return full;
}

/** 非空原始行（verifyChain 需要它把「坏行」当作链断点，而不是静默丢弃）。 */
function rawLines(): string[] {
  const file = auditFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
}

function parseRow(line: string): AuditEvent | null {
  try {
    const v = JSON.parse(line);
    // 只接受对象：null/数字/字符串/数组混进来会让 score/tail/append 抛 TypeError（审计 DoS）
    return v && typeof v === "object" && !Array.isArray(v) ? (v as AuditEvent) : null;
  } catch { return null; }
}

function rows(): AuditEvent[] {
  return rawLines().map(parseRow).filter((r): r is AuditEvent => r !== null);
}

/** Last parsed record (its hash/seq if chained) plus the number of parsed rows. */
function lastRecord(): { hash?: string; seq?: number; count: number } {
  const all = rows();
  const last = all[all.length - 1];
  return { hash: last?.hash, seq: last?.seq, count: all.length };
}

/** Result of integrity-checking the hash chain. */
export interface ChainResult {
  ok: boolean;
  /** chained (hashed) rows that were verified */
  checked: number;
  /** legacy rows without hash/prev_hash, tolerated only as an unchained prefix */
  legacy: number;
  total: number;
  /** 1-based row index where the chain broke, null when ok */
  broken_at: number | null;
  reason: string | null;
  /** seq of the last parsed row in the log (null when it carries no seq) */
  head_seq: number | null;
  /** chain hash of the last parsed row (null for a legacy-only prefix) */
  head_hash: string | null;
  /** true when the log ends before the recorded chain head (tail deleted / rolled back) */
  tail_truncated: boolean;
}

/**
 * Walk the audit log in order and recompute prev_hash/hash for every chained row.
 * Detects field tampering, reordering, swapped prev_hash and dropped rows (prev_hash
 * or seq gap). Rows written before the chain existed (no `hash`) are a legacy prefix
 * and do not fail verification; a legacy row after a chained one does.
 *
 * Because an internally consistent log can also be *truncated*, the walk is compared
 * against the external head anchor (`audit/head.json`, written by append()). A log that
 * ends before the anchor — fewer rows, smaller seq, or a different hash at the anchored
 * row — is reported as tail truncation/rollback. A missing anchor on a chained log, or a
 * corrupt anchor, fails closed (ok=false) instead of silently passing.
 */
export function verifyChain(): ChainResult {
  const lines = rawLines();
  const all: AuditEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = parseRow(lines[i]);
    if (!r) {
      return {
        ok: false, checked: 0, legacy: 0, total: lines.length, broken_at: i + 1,
        reason: "malformed row (not a JSON object)", head_seq: null, head_hash: null, tail_truncated: false,
      };
    }
    all.push(r);
  }
  let prev = GENESIS;
  let prevSeq = 0;
  let checked = 0;
  let legacy = 0;
  let chained = false;
  const res: ChainResult = {
    ok: true, checked: 0, legacy: 0, total: all.length, broken_at: null, reason: null,
    head_seq: null, head_hash: null, tail_truncated: false,
  };
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    const at = i + 1;
    if (r.hash === undefined || r.prev_hash === undefined) {
      if (chained) return { ...res, ok: false, broken_at: at, reason: "legacy row after chain" };
      legacy++;
      prevSeq = typeof r.seq === "number" ? r.seq : prevSeq + 1;
      continue;
    }
    if (typeof r.seq === "number" && r.seq !== prevSeq + 1) {
      return { ...res, ok: false, broken_at: at, reason: `seq gap (expected ${prevSeq + 1}, got ${r.seq})` };
    }
    if (r.prev_hash !== prev) {
      return { ...res, ok: false, broken_at: at, reason: "prev_hash mismatch (row dropped or reordered)" };
    }
    const expect = hashEvent(r, r.prev_hash);
    if (expect !== r.hash) {
      return { ...res, ok: false, broken_at: at, reason: "hash mismatch (row tampered)" };
    }
    checked++;
    prevSeq = typeof r.seq === "number" ? r.seq : prevSeq + 1;
    prev = r.hash;
    chained = true;
  }

  const last = all[all.length - 1];
  const base: ChainResult = {
    ...res, checked, legacy,
    head_seq: typeof last?.seq === "number" ? last.seq : null,
    head_hash: last?.hash ?? null,
  };

  const anchor = readHead();
  if (anchor.state === "corrupt") {
    return { ...base, ok: false, reason: `anchor corrupted (${anchor.error}); failing closed` };
  }
  if (anchor.state === "missing") {
    // No anchor: fine for a fresh/empty log or a legacy-only prefix (nothing chained yet);
    // a chained log whose anchor was deleted can no longer be proven intact → fail closed.
    if (base.head_hash === null) return base;
    return { ...base, ok: false, reason: "anchor missing (deleted head.json); failing closed" };
  }

  const a = anchor.head;
  const logEnd = base.head_seq ?? all.length;
  if (all.length < a.row_count || (base.head_seq !== null && base.head_seq < a.last_seq)) {
    return {
      ...base, ok: false, tail_truncated: true,
      reason: `tail truncated or rolled back (anchor seq ${a.last_seq}, log ends at ${logEnd})`,
    };
  }
  // The row the anchor points at must still be the same row (catches a truncated tail
  // that was re-appended with fresh rows, and in-place rewrites of the chain head).
  if (a.row_count >= 1) {
    const anchored = all[a.row_count - 1];
    const anchoredSeq = typeof anchored?.seq === "number" ? anchored.seq : null;
    if (!anchored || anchored.hash !== a.last_hash || anchoredSeq !== a.last_seq) {
      return {
        ...base, ok: false, tail_truncated: true,
        reason: `chain head mismatch at row ${a.row_count} (anchor seq ${a.last_seq}, log has seq ${anchoredSeq ?? "none"} hash ${anchored?.hash ?? "none"})`,
      };
    }
  }
  // more rows than the anchor means the anchor lagged (crash between append and head
  // write) — the chain walk above already vouched for those rows, so this is not a failure.
  return base;
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

export interface VerifyResult {
  session: string;
  audit_rows: number;
  expected_calls: number;
  ok: boolean;
  gap: number;
  extra: number;
  level: string;
  /** reconciliation-only verdict, present when chain checking was requested */
  reconciled?: boolean;
  chain?: ChainResult;
}

export function verify(session: string, expectedCalls: number, opts: { chain?: boolean } = {}): VerifyResult {
  const n = rows().filter((r) => r.session === session).length;
  const reconciled = n === expectedCalls;
  const base: VerifyResult = {
    session, audit_rows: n, expected_calls: expectedCalls, ok: reconciled,
    gap: Math.max(0, expectedCalls - n),
    extra: Math.max(0, n - expectedCalls),
    level: reconciled ? "ok" : "mismatch",
  };
  if (!opts.chain) return base;
  const chain = verifyChain();
  return { ...base, ok: reconciled && chain.ok, reconciled, chain };
}

export function tail(n = 20): AuditEvent[] {
  return rows().slice(-n);
}
