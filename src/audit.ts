import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  truncateSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

/**
 * Write-ahead record of an in-flight append: the row that is about to be appended.
 *
 * The checkpoint is updated *before* the row hits the log (`pending` = the new row) and
 * confirmed after (`pending` = null). A crash in between therefore leaves a checkpoint
 * that lags by exactly the announced row, which is verifiable — and a log that grows past
 * the anchored `row_count` **without** a matching announcement is provably not ours.
 */
export interface ChainPending {
  last_seq: number;
  last_hash: string;
  row_count: number;
}

/**
 * Off-box checkpoint: the same tail descriptor as the local anchor plus a stable slot id.
 *
 * `head.json` sits next to the log, so an attacker who can rewrite the log can usually
 * rewrite the anchor too ("same domain"). An off-box checkpoint is written to a path the
 * operator chooses *outside* the audit dir (`DIA_AUDIT_CHECKPOINT`, typically another
 * filesystem / user / box), so a same-domain rewrite leaves it behind and becomes visible.
 */
export interface ChainCheckpoint extends ChainHead {
  /** identity of this checkpoint slot (random on creation, preserved on every update). */
  checkpoint_id: string;
  /** announced but not yet confirmed append (two-phase anchor; null when settled). */
  pending?: ChainPending | null;
}

/** Env var holding the absolute path of the off-box checkpoint. Unset = protection off. */
export const CHECKPOINT_ENV = "DIA_AUDIT_CHECKPOINT";

/**
 * Configured checkpoint path (absolute, resolved) or null when off-box anchoring is off.
 * Path validation (must be absolute, must not live inside the audit dir) happens in
 * checkpointTarget() so verify/append can report a misconfiguration instead of guessing.
 */
export function checkpointFile(): string | null {
  const raw = (process.env[CHECKPOINT_ENV] || "").trim();
  return raw ? resolve(raw) : null;
}

type CheckpointTarget =
  | { ok: true; path: string }
  | { ok: false; path: string | null; error: string };

/**
 * Resolve the deepest existing ancestor so symlinks cannot smuggle the "off-box" path
 * back inside the audit dir (same-domain anchor = no protection at all).
 */
function realpathDeep(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.slice().reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Validate DIA_AUDIT_CHECKPOINT. Returns null when unset (off-box anchoring disabled).
 *
 * Rules: absolute path only (relative paths would silently follow cwd), must not resolve
 * inside the audit dir (that would be same-domain again), and must not be a directory.
 */
function checkpointTarget(): CheckpointTarget | null {
  const file = checkpointFile();
  if (!file) return null;
  const raw = (process.env[CHECKPOINT_ENV] || "").trim();
  if (!isAbsolute(raw)) {
    return { ok: false, path: null, error: `${CHECKPOINT_ENV} must be an absolute path (got ${JSON.stringify(raw)})` };
  }
  const audit = realpathDeep(auditDir());
  const target = realpathDeep(file);
  if (target === audit || target.startsWith(audit + sep)) {
    return {
      ok: false, path: file,
      error: `${CHECKPOINT_ENV} must live outside ${auditDir()} — a checkpoint inside the audit dir cannot survive a same-domain rewrite`,
    };
  }
  try {
    if (existsSync(file) && statSync(file).isDirectory()) {
      return { ok: false, path: file, error: `${CHECKPOINT_ENV} points at a directory (${file}); expected a file path` };
    }
  } catch { /* unreadable stat -> let the write fail loudly */ }
  return { ok: true, path: file };
}

type CheckpointRead =
  | { state: "ok"; checkpoint: ChainCheckpoint; path: string }
  | { state: "missing"; path: string }
  | { state: "corrupt"; path: string; error: string }
  | { state: "misconfigured"; path: string | null; error: string };

function readCheckpoint(target: CheckpointTarget | null = checkpointTarget()): CheckpointRead | null {
  if (!target) return null;
  if (!target.ok) return { state: "misconfigured", path: target.path, error: target.error };
  const file = target.path;
  if (!existsSync(file)) return { state: "missing", path: file };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { state: "corrupt", path: file, error: `unreadable or invalid json: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "corrupt", path: file, error: "bad shape" };
  }
  const { last_seq: seq, last_hash: hash, row_count: count, checkpoint_id: id } = parsed;
  if (!Number.isInteger(seq) || seq < 0) return { state: "corrupt", path: file, error: "bad last_seq" };
  if (typeof hash !== "string" || !new RegExp(`^[0-9a-f]{${HASH_LEN}}$`).test(hash)) {
    return { state: "corrupt", path: file, error: "bad last_hash" };
  }
  if (!Number.isInteger(count) || count < 0) return { state: "corrupt", path: file, error: "bad row_count" };
  if (typeof id !== "string" || !id.trim()) return { state: "corrupt", path: file, error: "bad checkpoint_id" };
  let pending: ChainPending | null = null;
  if (parsed.pending !== undefined && parsed.pending !== null) {
    const p = parsed.pending;
    if (!p || typeof p !== "object" || Array.isArray(p)) return { state: "corrupt", path: file, error: "bad pending" };
    if (!Number.isInteger(p.last_seq) || p.last_seq < 1) return { state: "corrupt", path: file, error: "bad pending.last_seq" };
    if (typeof p.last_hash !== "string" || !new RegExp(`^[0-9a-f]{${HASH_LEN}}$`).test(p.last_hash)) {
      return { state: "corrupt", path: file, error: "bad pending.last_hash" };
    }
    if (!Number.isInteger(p.row_count) || p.row_count < 1) return { state: "corrupt", path: file, error: "bad pending.row_count" };
    pending = { last_seq: p.last_seq, last_hash: p.last_hash, row_count: p.row_count };
  }
  return {
    state: "ok",
    path: file,
    checkpoint: {
      last_seq: seq, last_hash: hash, row_count: count, checkpoint_id: id, pending,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
    },
  };
}

let checkpointTmpCounter = 0;

/**
 * Atomic off-box checkpoint write: temp file (0600) in the target dir + rename.
 * Never writes partial anchors; throws so append() can fail closed.
 */
function writeCheckpoint(cp: ChainCheckpoint, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++checkpointTmpCounter}.tmp`;
  writeFileSync(tmp, JSON.stringify(cp) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort on filesystems without modes */ }
  renameSync(tmp, file);
}

export type CheckpointVerdict = "consistent" | "lagging" | "rolled_back" | "forged_same_domain";

/** Last checkpoint write failure (diagnostics; append() also throws). */
let checkpointFailure: { at: string; path: string; error: string } | null = null;

export function lastCheckpointError(): { at: string; path: string; error: string } | null {
  return checkpointFailure ? { ...checkpointFailure } : null;
}

/**
 * Compare an off-box checkpoint against the (already parsed) local log.
 *
 * - `consistent`: checkpoint names exactly the last row.
 * - `lagging`: the log has exactly the rows the checkpoint *announced* as in-flight
 *   (`pending`), i.e. the crash window between "announced" and "confirmed". Benign, warn only.
 * - `rolled_back`: the log ends before the checkpoint (tail deleted / prefix restored).
 * - `forged_same_domain`: the checkpoint row exists but differs — log+head rewritten
 *   in place — **or** the log grew past the anchored row count without the off-box
 *   checkpoint ever announcing those rows. The latter is why `pending` exists: a
 *   same-domain attacker can append chain-legal rows and rewrite head.json, but it
 *   cannot add the matching write-ahead record off-box.
 */
function compareCheckpoint(
  cp: ChainCheckpoint,
  all: AuditEvent[],
): { verdict: CheckpointVerdict; reason: string | null } {
  const count = all.length;
  const last = all[count - 1];
  const logSeq = typeof last?.seq === "number" ? last.seq : count;
  const logHash = last?.hash ?? GENESIS;
  if (cp.row_count === count) {
    if (cp.last_seq === logSeq && cp.last_hash === logHash) return { verdict: "consistent", reason: null };
    return {
      verdict: "forged_same_domain",
      reason: `off-box checkpoint disagrees with the local head at row ${count} (checkpoint seq ${cp.last_seq} hash ${cp.last_hash} vs log seq ${logSeq} hash ${logHash})`,
    };
  }
  if (cp.row_count > count) {
    return {
      verdict: "rolled_back",
      reason: `log rolled back below the off-box checkpoint (checkpoint seq ${cp.last_seq} / ${cp.row_count} rows, log ends at ${logSeq} / ${count} rows)`,
    };
  }
  // checkpoint behind the log: only the row the checkpoint announced may be unconfirmed
  const p = cp.pending;
  if (p && p.row_count === count && p.last_seq === logSeq && p.last_hash === logHash) {
    return {
      verdict: "lagging",
      reason: `off-box checkpoint lags the log by ${count - cp.row_count} row(s) but announced that append (pending seq ${p.last_seq} hash ${p.last_hash}); interrupted append / in-flight writer`,
    };
  }
  return {
    verdict: "forged_same_domain",
    reason: `log has ${count - cp.row_count} row(s) beyond the off-box checkpoint (anchored at seq ${cp.last_seq} / row ${cp.row_count}) that the checkpoint never announced (pending ${p ? `seq ${p.last_seq} hash ${p.last_hash}` : "absent"} vs log seq ${logSeq} hash ${logHash})`,
  };
}

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
  // same last row and fork the chain. The off-box checkpoint is written last (head →
  // checkpoint order) so an interrupted append leaves a *lagging* checkpoint, never a
  // checkpoint that points at a row the log does not have.
  const release = acquireLock();
  try {
    const target = checkpointTarget();
    if (target && !target.ok) throw new Error(`E_AUDIT_CHECKPOINT: ${target.error}`);
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
    // Off-box anchor: a deleted/corrupted/mismatching checkpoint means the local log is
    // no longer provable → refuse to append (fail-closed) instead of extending a chain
    // that a same-domain rewrite already compromised.
    const cpRead = target ? readCheckpoint(target) : null;
    let checkpoint_id: string | null = null;
    if (cpRead?.state === "misconfigured") throw new Error(`E_AUDIT_CHECKPOINT: ${cpRead.error}`);
    if (cpRead?.state === "corrupt") {
      throw new Error(`E_AUDIT_CHAIN: off-box 检查点损坏（${cpRead.error}）；拒绝追加，先人工核查 ${cpRead.path}`);
    }
    if (cpRead?.state === "ok") {
      const cmp = compareCheckpoint(cpRead.checkpoint, last.all);
      if (cmp.verdict === "rolled_back" || cmp.verdict === "forged_same_domain") {
        throw new Error(`E_AUDIT_CHAIN: ${cmp.reason}；拒绝在无法证明完整的链上追加（检查点 ${cpRead.path}）`);
      }
      checkpoint_id = cpRead.checkpoint.checkpoint_id;
    }
    if (cpRead?.state === "missing" && last.hash) {
      throw new Error(`E_AUDIT_CHAIN: off-box 检查点缺失但日志已有链；拒绝追加，先人工核查 ${cpRead.path}`);
    }
    const prev_hash = last.hash ?? GENESIS;
    const seq = (last.seq ?? last.count) + 1;
    const base: AuditEvent = { seq, ts: new Date().toISOString(), params_hash, ...rest } as AuditEvent;
    full = { ...base, prev_hash };
    full.hash = hashEvent(full, prev_hash);
    // remember the pre-append state: if the off-box write fails we roll back to it so a
    // later verify() cannot see "protected" rows behind a stale checkpoint
    const before = {
      size: existsSync(file) ? statSync(file).size : 0,
      head: existsSync(headFile()) ? readFileSync(headFile()) : null,
    };
    // Two-phase off-box anchor: announce the row *before* it exists in the log, confirm
    // it after the head write. A crash in between leaves a checkpoint that lags by an
    // *announced* row (recoverable, `lagging`); rows appended without an announcement are
    // unverifiable — that is what makes "append forged rows + rewrite head.json" visible.
    const anchored: ChainHead = { last_seq: last.seq ?? 0, last_hash: last.hash ?? GENESIS, row_count: last.count };
    const cpId = checkpoint_id || randomUUID();
    if (target && target.ok) {
      try {
        writeCheckpoint({ ...anchored, checkpoint_id: cpId, updated_at: new Date().toISOString(),
          pending: { last_seq: seq, last_hash: full.hash, row_count: last.count + 1 } }, target.path);
      } catch (e) {
        const msg = `E_AUDIT_CHECKPOINT: 无法写入 off-box 检查点 ${target.path}（${(e as Error).message}）；已放弃本次追加，拒绝在无外部锚点时继续`;
        checkpointFailure = { at: new Date().toISOString(), path: target.path, error: msg };
        throw new Error(msg);
      }
    }
    appendFileSync(file, JSON.stringify(full) + "\n");
    writeHead({
      last_seq: seq,
      last_hash: full.hash,
      row_count: last.count + 1,
      updated_at: full.ts,
    });
    if (target && target.ok) {
      try {
        writeCheckpoint({
          last_seq: seq,
          last_hash: full.hash,
          row_count: last.count + 1,
          checkpoint_id: cpId,
          updated_at: full.ts,
          pending: null,
        }, target.path);
        checkpointFailure = null;
      } catch (e) {
        try { truncateSync(file, before.size); } catch { /* degraded: chain stays consistent */ }
        try {
          if (before.head === null) rmSync(headFile(), { force: true });
          else writeFileSync(headFile(), before.head);
        } catch { /* degraded: head may lag, verify() still detects it */ }
        // drop the announcement too, so an aborted row cannot be replayed into a
        // "lagging but announced" state later on (best effort: the append already failed)
        try { writeCheckpoint({ ...anchored, checkpoint_id: cpId, pending: null }, target.path); } catch { /* stale pending stays benign */ }
        const msg = `E_AUDIT_CHECKPOINT: 无法写入 off-box 检查点 ${target.path}（${(e as Error).message}）；已回滚本次追加，拒绝在无外部锚点时继续`;
        checkpointFailure = { at: new Date().toISOString(), path: target.path, error: msg };
        throw new Error(msg);
      }
    }
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
function lastRecord(): { hash?: string; seq?: number; count: number; all: AuditEvent[] } {
  const all = rows();
  const last = all[all.length - 1];
  return { hash: last?.hash, seq: last?.seq, count: all.length, all };
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
  /** off-box checkpoint status (see CheckpointProtection) */
  protection: CheckpointProtection;
}

/**
 * Cross-source check against the off-box checkpoint (DIA_AUDIT_CHECKPOINT).
 *
 * `state`:
 * - `anchored`   — checkpoint configured and readable; `verdict` says whether it agrees.
 * - `unprotected`— no checkpoint configured: the log is only protected against
 *                  same-domain-blind tampering. A warning, not a failure (nothing promised).
 * - `missing`    — configured but the file is gone: either an operator error or an
 *                  attacker deleting the evidence → fail closed once the log is chained.
 * - `corrupt`    — the file exists but is not a valid checkpoint → fail closed.
 * - `misconfigured` — bad path (relative, inside the audit dir, a directory) → fail closed.
 */
export interface CheckpointProtection {
  state: "anchored" | "unprotected" | "missing" | "corrupt" | "misconfigured";
  /** configured path (null when unset / unresolvable) */
  path: string | null;
  checkpoint: ChainCheckpoint | null;
  /** only meaningful when state === "anchored" */
  verdict: CheckpointVerdict | null;
  reason: string | null;
  /** true when the state/verdict must fail the whole verification (fail closed) */
  fatal: boolean;
}

type LocalChainResult = Omit<ChainResult, "protection">;

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
 *
 * This is the *local* half only; verifyChain() adds the off-box checkpoint comparison.
 */
function verifyLocal(): LocalChainResult {
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
  const res: LocalChainResult = {
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
  const base: LocalChainResult = {
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

/**
 * Full verification: local chain + local anchor (verifyLocal), then a cross-source check
 * against the off-box checkpoint.
 *
 * The local anchor lives next to the log, so a same-domain attacker rewrites both and
 * verifyLocal passes. With `DIA_AUDIT_CHECKPOINT` set, the checkpoint is compared to the
 * (possibly forged) head:
 * - checkpoint ahead of the log / mismatch → rolled back / forged_same_domain → ok=false
 * - checkpoint behind by exactly the row it announced (`pending`) → `lagging` (interrupted
 *   append), warn only; anything else beyond the anchor is forged_same_domain → ok=false
 * - checkpoint missing or misconfigured while the log is chained → ok=false (fail closed)
 * - checkpoint unset → `unprotected` warning; the local verdict is unchanged.
 */
export function verifyChain(): ChainResult {
  const local = verifyLocal();
  const target = checkpointTarget();
  const protection = checkProtection(local, target);
  const next: ChainResult = { ...local, protection };
  if (protection.verdict === "rolled_back") next.tail_truncated = true;
  if (protection.fatal) {
    next.ok = false;
    if (!next.reason) next.reason = protection.reason;
  }
  return next;
}

/**
 * Compare the off-box checkpoint against the local result. Pure read: `fatal` tells the
 * caller whether the whole verification must fail (verifyChain) or block an append.
 */
function checkProtection(local: LocalChainResult, target: CheckpointTarget | null): CheckpointProtection {
  const read = readCheckpoint(target);
  if (!read) {
    return {
      state: "unprotected", path: null, checkpoint: null, verdict: null, fatal: false,
      reason: `off-box checkpoint not configured (${CHECKPOINT_ENV}); the log only detects same-domain tampering`,
    };
  }
  if (read.state === "misconfigured") {
    return { state: "misconfigured", path: read.path, checkpoint: null, verdict: null, fatal: true, reason: read.error };
  }
  if (read.state === "corrupt") {
    return {
      state: "corrupt", path: read.path, checkpoint: null, verdict: null, fatal: true,
      reason: `off-box checkpoint corrupted (${read.error}); failing closed`,
    };
  }
  if (read.state === "missing") {
    const chained = local.head_hash !== null;
    return {
      state: "missing", path: read.path, checkpoint: null, verdict: null, fatal: chained,
      reason: chained
        ? `off-box checkpoint missing (${read.path}); the log can no longer be proven intact — failing closed`
        : `off-box checkpoint missing (${read.path}); nothing chained yet`,
    };
  }
  const cmp = compareCheckpoint(read.checkpoint, rows());
  const fatal = cmp.verdict === "rolled_back" || cmp.verdict === "forged_same_domain";
  return {
    state: "anchored", path: read.path, checkpoint: read.checkpoint, verdict: cmp.verdict,
    fatal, reason: cmp.reason,
  };
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
