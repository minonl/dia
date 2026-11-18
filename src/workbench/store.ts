// dia workbench —— 存储层（tracks/beats/queue/drift + derived 快照）
//
// 设计：docs/design/workbench.md §3
// 约定：
//   · 意图文件 append-only，fold 容错（坏行跳过并计数）
//   · derived/ 整目录可删；写快照走 tmp + rename
//   · 所有写操作用 withLock("workbench-*") 串行化

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, statSync, lstatSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import { withLock } from "../collab.ts";
import * as collab from "../collab.ts";
import * as paths from "../paths.ts";
import { loadConfig, verdictFor, configPath, DEFAULT_CONFIG, matchPattern, type DurableRule, type EphemeralRule } from "./config.ts";
import type { Snapshot, Track, TrackSessionRef, TrackStatus } from "./schema.ts";

export const workbenchDir = () => join(paths.diaHome(), "workbench");
export const derivedDir = () => join(workbenchDir(), "derived");
export const tracksFile = () => join(workbenchDir(), "tracks.jsonl");
export const beatsFile = () => join(workbenchDir(), "beats.jsonl");
export const queueFile = () => join(workbenchDir(), "queue.jsonl");
export const driftFile = () => join(workbenchDir(), "drift.jsonl");
export const snapshotFile = () => join(derivedDir(), "snapshot.json");
export const configFile = () => join(workbenchDir(), "config.json");

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 写前校验：相对 workbench 根必须在白名单内（durable 精确 / ephemeral 模式）。 */
function assertWritable(file: string): { rel: string; rule?: DurableRule | EphemeralRule } {
  const root = workbenchDir();
  const rel = relative(root, file).split("\\").join("/");
  const v = verdictFor(rel);
  if (!v.allowed) throw new Error(v.reason || `E_WB_WHITELIST: ${rel}`);
  return { rel, rule: v.rule };
}

function countLines(file: string): number {
  try { return readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}

function rotateLines(file: string, ttlH?: number, maxLines?: number, now = Date.now()) {
  const { rows } = readJsonl<{ ts?: string }>(file);
  let keep = rows;
  if (ttlH && ttlH > 0) {
    const cutoff = now - ttlH * 3600_000;
    keep = keep.filter((r) => {
      const t = Date.parse(String(r?.ts || ""));
      return Number.isNaN(t) ? true : t >= cutoff;
    });
  }
  if (maxLines && maxLines > 0 && keep.length > maxLines) keep = keep.slice(-maxLines);
  writeAtomic(file, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
}

/** tracks.jsonl 压缩：折叠成「每个 track 一条 open + 活跃 bind + tasks」，历史事件丢弃（允许有损）。 */
function compactTracksLocked(): number {
  const { tracks } = foldTracks();
  const lines: TrackEvent[] = [];
  const ts = new Date().toISOString();
  for (const t of tracks) {
    lines.push({
      ts, event: "open", id: t.id, title: t.title, goal: t.goal, status: t.status,
      stage: t.stage, next: t.next, repo: t.repo, prio: t.prio, owner: t.owner,
      remind_at: t.remind_at, refs: t.refs,
    });
    for (const s of t.sessions.filter((x) => !x.unbound_at)) {
      lines.push({ ts, event: "bind", id: t.id, session: s.session_id, role: s.role, host: s.host });
    }
    for (const task of t.tasks) lines.push({ ts, event: "attach_task", id: t.id, task });
    if (t.closed_reason) lines.push({ ts, event: "close", id: t.id, reason: t.closed_reason });
  }
  writeAtomic(tracksFile(), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return tracks.length;
}

export function compactTracks(): number {
  return withLock("workbench-tracks", () => compactTracksLocked());
}

/** 写前执行溢出策略：fail 抛错、rotate 截断、compact 折叠。 */
function enforceCap(file: string, rule: DurableRule | EphemeralRule, now = Date.now()) {
  if (!existsSync(file)) return;
  const st = statSync(file);
  const lines = rule.max_lines ? countLines(file) : 0;
  const over = (rule.max_bytes && st.size > rule.max_bytes) || (rule.max_lines && lines > rule.max_lines);
  if (!over) return;
  const policy = rule.on_overflow || "fail";
  if (policy === "rotate") return rotateLines(file, (rule as EphemeralRule).ttl_h, rule.max_lines, now);
  if (policy === "compact" && file === tracksFile()) {
    compactTracksLocked();
    const after = statSync(file);
    const linesAfter = countLines(file);
    if ((rule.max_bytes && after.size > rule.max_bytes) || (rule.max_lines && linesAfter > rule.max_lines)) {
      throw new Error(`E_WB_OVERFLOW: tracks 压缩后仍超限（${linesAfter} 行/${after.size}B）；请先收敛 track 数量`);
    }
    return;
  }
  throw new Error(`E_WB_OVERFLOW: ${relative(workbenchDir(), file)} 超过上限（${st.size}B/${lines} 行）；先跑 \`dia wb gc --apply\``);
}

function appendLine(file: string, obj: unknown) {
  const { rule } = assertWritable(file);
  if (rule) enforceCap(file, rule);
  ensureDir(join(file, ".."));
  appendFileSync(file, JSON.stringify(obj) + "\n", { mode: 0o600 });
}

export function writeAtomic(file: string, data: string) {
  assertWritable(file);
  ensureDir(join(file, ".."));
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/** 读 JSONL；坏行计数返回，调用方决定是否告警。 */
export function readJsonl<T>(file: string): { rows: T[]; bad: number } {
  if (!existsSync(file)) return { rows: [], bad: 0 };
  const rows: T[] = [];
  let bad = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { bad++; }
  }
  return { rows, bad };
}

export type TrackEvent =
  | { ts: string; event: "open"; id: string; title: string; goal?: string; status?: TrackStatus; stage?: string; next?: string; repo?: string[]; prio?: string; owner?: string; remind_at?: string; refs?: Track["refs"] }
  | { ts: string; event: "bind"; id: string; session: string; role?: Track["sessions"][number]["role"]; host?: string }
  | { ts: string; event: "unbind"; id: string; session: string }
  | { ts: string; event: "stage"; id: string; status?: TrackStatus; stage?: string; reason?: string; next?: string }
  | { ts: string; event: "next"; id: string; next: string; waiting_on?: Track["waiting_on"]; remind_at?: string }
  | { ts: string; event: "handoff"; id: string; from: string; to: string; reason: string }
  | { ts: string; event: "attach_task"; id: string; task: string }
  | { ts: string; event: "close"; id: string; reason: string; evidence?: string }
  | { ts: string; event: "update"; id: string; title?: string; goal?: string; repo?: string[]; prio?: string; owner?: string; next?: string; remind_at?: string; refs?: Track["refs"] };

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** 折叠 tracks.jsonl。未知事件与坏行忽略（前向兼容）。 */
export function foldTracks(): { tracks: Track[]; bad: number } {
  const { rows, bad } = readJsonl<TrackEvent>(tracksFile());
  const map = new Map<string, Track>();
  const bind = (id: string, ref: TrackSessionRef) => {
    const t = map.get(id);
    if (!t || t.sessions.some((s) => s.session_id === ref.session_id && !s.unbound_at)) return;
    t.sessions.push(ref);
  };
  for (const e of rows) {
    if (!e || typeof e !== "object" || !("event" in e)) continue;
    if (e.event === "open") {
      if (!e.id || map.has(e.id)) continue;
      map.set(e.id, {
        id: e.id,
        title: e.title || "(untitled)",
        goal: e.goal || "",
        status: e.status || "open",
        stage: e.stage || "",
        next: e.next || "",
        remind_at: e.remind_at,
        repo: uniq(e.repo || []),
        prio: e.prio || "P2",
        owner: e.owner,
        refs: e.refs || [],
        sessions: [],
        tasks: [],
        created_at: e.ts,
        updated_at: e.ts,
      });
      continue;
    }
    const t = map.get(e.id);
    if (!t) continue;
    t.updated_at = e.ts;
    switch (e.event) {
      case "bind":
        if (e.session) bind(t.id, { session_id: e.session, role: e.role || "worker", host: e.host || "unknown", bound_at: e.ts });
        break;
      case "unbind": {
        for (const s of t.sessions) if (s.session_id === e.session && !s.unbound_at) s.unbound_at = e.ts;
        break;
      }
      case "stage":
        if (e.status) t.status = e.status;
        if (e.stage !== undefined) t.stage = e.stage;
        if (e.next !== undefined) t.next = e.next;
        break;
      case "next":
        t.next = e.next;
        if (e.waiting_on !== undefined) t.waiting_on = e.waiting_on;
        if (e.remind_at !== undefined) t.remind_at = e.remind_at;
        break;
      case "handoff": {
        const from = t.sessions.find((s) => s.session_id === e.from && !s.unbound_at);
        if (from) from.unbound_at = e.ts;
        bind(t.id, { session_id: e.to, role: "lead", host: "unknown", bound_at: e.ts });
        t.handoff = { from: e.from, to: e.to, at: e.ts, reason: e.reason };
        break;
      }
      case "attach_task":
        if (e.task) t.tasks = uniq([...t.tasks, e.task]);
        break;
      case "close":
        t.status = e.reason === "abandoned" ? "abandoned" : "done";
        t.closed_reason = e.reason;
        break;
      case "update":
        if (e.title !== undefined) t.title = e.title;
        if (e.goal !== undefined) t.goal = e.goal;
        if (e.repo !== undefined) t.repo = uniq(e.repo);
        if (e.prio !== undefined) t.prio = e.prio;
        if (e.owner !== undefined) t.owner = e.owner;
        if (e.next !== undefined) t.next = e.next;
        if (e.remind_at !== undefined) t.remind_at = e.remind_at;
        if (e.refs !== undefined) t.refs = e.refs;
        break;
    }
  }
  return { tracks: [...map.values()].sort((a, b) => a.id.localeCompare(b.id)), bad };
}

export function trackId(title: string, repo: string[] = []): string {
  // 加随机后缀：同毫秒并发 open 不能撞同一 id（实测 flaky）
  return "tr-" + createHash("sha1").update(title + "|" + [...repo].sort().join(",") + "|" + Date.now() + "|" + randomBytes(4).toString("hex")).digest("hex").slice(0, 8);
}

export function appendTrack(e: TrackEvent): void {
  withLock("workbench-tracks", () => appendLine(tracksFile(), e));
}

export interface Beat { ts: string; session: string; host?: string; cwd?: string; track?: string; note?: string }

export function appendBeat(b: Beat): void {
  withLock("workbench-beats", () => appendLine(beatsFile(), b));
}

export function readBeats(): { rows: Beat[]; bad: number } {
  return readJsonl<Beat>(beatsFile());
}

export interface QueuedMessage {
  id: string;
  addr: string;
  kind: string;
  subject: string;
  /** 兼容旧行：外链正文（不可靠，出队时优先 body/body_ref） */
  body_file?: string;
  body?: string;
  /** 大正文落在 ~/.dia/collab/bodies/<id>.md（相对 collab 根） */
  body_ref?: string;
  refs?: Record<string, string>;
  reason: string;
  created_at: string;
  resolved_at?: string | null;
  // ── 出队必需：保留原 thread/seq/幂等键，改投时消息不可变语义不破 ──
  thread_id?: string;
  seq?: number;
  idempotency_key?: string;
  from?: string;
  requires_reply?: boolean;
  deadline?: string;
  class_snapshot?: number;
  class_why?: string[];
  /** 出队成功后写：先写这个，再写 resolved_at（崩溃窗口不会二次发送） */
  delivered_msg_id?: string;
  /** 本次解析到的目标（多目标用逗号分隔） */
  deliver_to?: string;
  tries?: number;
  last_try_at?: string;
}

export function readQueue(): { rows: QueuedMessage[]; bad: number } {
  return readJsonl<QueuedMessage>(queueFile());
}

/** queue 行数硬上限（白名单 durable：max_lines=2000，丢消息不可接受 → fail） */
export const QUEUE_MAX_LINES = 2_000;

export function appendQueue(row: QueuedMessage): QueuedMessage {
  withLock("workbench-queue", () => appendLine(queueFile(), row));
  return row;
}

/** 按 id 原地改一行（重写整文件；行数不增长，故只走白名单校验，不触发溢出策略）。 */
export function patchQueue(id: string, patch: Partial<QueuedMessage> | ((row: QueuedMessage) => Partial<QueuedMessage>)): QueuedMessage | null {
  return withLock("workbench-queue", () => {
    const { rows } = readQueue();
    const idx = rows.findIndex((r) => r?.id === id);
    if (idx < 0) return null;
    const next = typeof patch === "function" ? patch(rows[idx]) : patch;
    const merged: QueuedMessage = { ...rows[idx], ...next, id: rows[idx].id };
    // undefined 值不落盘（保持行内字段干净）
    for (const k of Object.keys(merged) as (keyof QueuedMessage)[]) {
      if (merged[k] === undefined) delete merged[k];
    }
    rows[idx] = merged;
    if (rows.length > QUEUE_MAX_LINES) {
      throw new Error(`E_WB_OVERFLOW: queue.jsonl 有 ${rows.length} 行（上限 ${QUEUE_MAX_LINES}）；先 \`dia msg retry --queue\` 出队清理`);
    }
    writeAtomic(queueFile(), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    return merged;
  });
}

export interface EnqueueInput {
  addr: string;
  kind: string;
  subject: string;
  body?: string;
  bodyFile?: string;
  refs?: Record<string, string>;
  reason: string;
  from: string;
  thread_id: string;
  seq?: number;
  idempotency_key: string;
  requires_reply?: boolean;
  deadline?: string;
  class_snapshot?: number;
  class_why?: string[];
}

/** 未解析地址入队；同 addr + 幂等键且未 resolved 的行直接复用（不追加）。 */
export function enqueueUnresolved(input: EnqueueInput): { row: QueuedMessage; reused: boolean } {
  return withLock("workbench-queue", () => {
    const { rows } = readQueue();
    const dup = rows.find((r) => r && !r.resolved_at && r.addr === input.addr && r.idempotency_key === input.idempotency_key);
    if (dup) return { row: dup, reused: true };

    const id = `q-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    let body = input.body;
    if (body === undefined && input.bodyFile) {
      try { body = readFileSync(input.bodyFile, "utf8"); } catch { body = undefined; }
    }
    let bodyRef: string | undefined;
    if (body !== undefined && Buffer.byteLength(body) > collab.limits.INLINE_BODY) {
      bodyRef = collab.stashBody(id, body);
      body = undefined;
    }
    const row: QueuedMessage = {
      id,
      addr: input.addr,
      kind: input.kind,
      subject: input.subject,
      body,
      body_ref: bodyRef,
      refs: input.refs && Object.keys(input.refs).length ? input.refs : undefined,
      reason: input.reason,
      created_at: new Date().toISOString(),
      resolved_at: null,
      thread_id: input.thread_id,
      seq: input.seq,
      idempotency_key: input.idempotency_key,
      from: input.from,
      requires_reply: input.requires_reply,
      deadline: input.deadline,
      class_snapshot: input.class_snapshot,
      class_why: input.class_why,
      tries: 0,
      last_try_at: undefined,
    };
    appendLine(queueFile(), row);
    return { row, reused: false };
  });
}

/** 路由解析结果（避免 store ↔ collab-route 循环依赖，由调用方注入 resolver） */
export type DrainResolution =
  | { kind: "session"; to: string; why?: string }
  | { kind: "fanout"; to: string[]; why?: string }
  | { kind: "unresolved"; reason: string };

export interface DrainOptions {
  track?: string;
  addr?: string;
  max?: number;
  now?: Date;
  /** 解析地址；缺省则只处理已有 deliver_to 的行 */
  resolve?: (addr: string) => DrainResolution;
  /** 允许 question/handoff 类多目标投递（默认只通知） */
  allowFanoutExecute?: boolean;
}

export interface DrainResult {
  sent: Array<{ queue_id: string; msg_id: string; to: string }>;
  skipped: Array<{ queue_id: string; reason: string }>;
  failed: Array<{ queue_id: string; error: string }>;
}

/** 出队：跳过已 resolved / 已 delivered；**永不二次 send**（先写 delivered_msg_id 再写 resolved_at）。 */
export function drainQueue(opts: DrainOptions = {}): DrainResult {
  const res: DrainResult = { sent: [], skipped: [], failed: [] };
  const max = opts.max && opts.max > 0 ? opts.max : 50;
  const { rows } = readQueue();
  for (const row of rows) {
    if (res.sent.length >= max) break;
    if (!row || row.resolved_at || row.delivered_msg_id) continue;
    if (opts.addr && row.addr !== opts.addr) continue;
    if (opts.track && !row.addr.includes(`track:${opts.track}`)) continue;
    if (!row.from) { res.skipped.push({ queue_id: row.id, reason: "no-from" }); continue; }
    if (!row.thread_id || !row.idempotency_key) { res.skipped.push({ queue_id: row.id, reason: "no-thread" }); continue; }

    let targets: string[];
    let why: string;
    if (opts.resolve) {
      const r = opts.resolve(row.addr);
      if (r.kind === "unresolved") {
        patchQueue(row.id, { tries: (row.tries || 0) + 1, last_try_at: new Date().toISOString() });
        res.skipped.push({ queue_id: row.id, reason: r.reason });
        continue;
      }
      targets = r.kind === "session" ? [r.to] : r.to.slice();
      why = r.why || r.kind;
    } else if (row.deliver_to) {
      targets = row.deliver_to.split(",").filter(Boolean);
      why = "deliver_to";
    } else {
      res.skipped.push({ queue_id: row.id, reason: "no-resolver" });
      continue;
    }
    if (!targets.length) {
      patchQueue(row.id, { tries: (row.tries || 0) + 1, last_try_at: new Date().toISOString() });
      res.skipped.push({ queue_id: row.id, reason: "no-route-eligible" });
      continue;
    }
    if (targets.length > 1 && row.kind !== "notify" && !opts.allowFanoutExecute) {
      res.skipped.push({ queue_id: row.id, reason: "fanout-needs-execute" });
      continue;
    }

    const body = row.body !== undefined ? row.body : row.body_ref ? collab.readBodyRef(row.body_ref) : undefined;
    const sentIds: string[] = [];
    const failed: string[] = [];
    for (const to of targets) {
      try {
        const m = collab.send({
          from: row.from,
          to,
          toAddr: row.addr,
          toResolved: to,
          kind: (row.kind as collab.Kind) || "notify",
          subject: row.subject,
          body,
          refs: { ...(row.refs || {}), route_why: why, route_from_queue: row.id },
          requiresReply: row.requires_reply,
          deadline: row.deadline,
          threadId: row.thread_id,
          idempotencyKey: targets.length > 1 ? `${row.idempotency_key}#${to}` : row.idempotency_key,
          classSnapshot: row.class_snapshot,
          classWhy: row.class_why,
        });
        sentIds.push(m.id);
        res.sent.push({ queue_id: row.id, msg_id: m.id, to });
      } catch (e: any) {
        failed.push(`${to}: ${e?.message || e}`);
        res.failed.push({ queue_id: row.id, error: `${to}: ${e?.message || e}` });
      }
    }
    // 先写 delivered_msg_id（崩溃窗口 → 下次跳过，绝不二次 send），再写 resolved_at
    if (sentIds.length) {
      patchQueue(row.id, { delivered_msg_id: sentIds.join(","), deliver_to: targets.join(","), last_try_at: new Date().toISOString() });
      if (!failed.length) patchQueue(row.id, { resolved_at: new Date().toISOString() });
    } else {
      patchQueue(row.id, { tries: (row.tries || 0) + 1, last_try_at: new Date().toISOString() });
    }
  }
  return res;
}

export function appendDrift(d: { kind: string; track?: string; subject: string; detail: string }): void {
  withLock("workbench-drift", () => appendLine(driftFile(), { ts: new Date().toISOString(), ...d }));
}

export function readDrift(): { rows: Array<{ ts: string; kind: string; track?: string; subject: string; detail: string }>; bad: number } {
  return readJsonl(driftFile());
}

export function readSnapshot(): Snapshot | null {
  try {
    const raw = readFileSync(snapshotFile(), "utf8");
    const s = JSON.parse(raw) as Snapshot;
    return s && s.schema_v === 1 ? s : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(s: Snapshot): void {
  withLock("workbench-derived", () => writeAtomic(snapshotFile(), JSON.stringify(s, null, 1) + "\n"));
}

export function derivedAgeMs(s: Snapshot, now = Date.now()): number {
  const t = Date.parse(s.as_of);
  return Number.isNaN(t) ? 0 : Math.max(0, now - t);
}

/** 一次性迁移：清 derived + 统计将被丢弃的旧数据（有损，见设计 §3.4）。 */
export interface MigrateReport {
  dry_run: boolean;
  legacy_opencode: { detected: boolean; rows: number } | null;
  legacy_claims: number;
  derived_present: boolean;
  written?: string[];
}

export function migrateWorkbench(opts: { dryRun?: boolean; now?: string } = {}): MigrateReport {
  const report: MigrateReport = {
    dry_run: !!opts.dryRun,
    legacy_opencode: null,
    legacy_claims: 0,
    derived_present: existsSync(derivedDir()),
    written: [],
  };
  if (!opts.dryRun) {
    ensureDir(workbenchDir());
    if (report.derived_present) rmSync(derivedDir(), { recursive: true, force: true });
    if (!existsSync(configPath())) {
      writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 1) + "\n", { mode: 0o600 });
      report.written?.push("config.json");
    }
  }
  return report;
}

export function listDerivedFiles(): string[] {
  if (!existsSync(derivedDir())) return [];
  return readdirSync(derivedDir(), { recursive: true } as any).map(String).sort();
}

// ── GC：白名单之外一律可清；ephemeral 按 TTL/行数收敛 ──────────────────────────

export interface GcEntry { path: string; bytes: number; reason: string }
export interface GcReport {
  schema_v: 1;
  dry_run: boolean;
  removed: GcEntry[];
  rotated: GcEntry[];
  skipped: Array<{ path: string; reason: string }>;
  kept: number;
  reclaimed_bytes: number;
  quota: { bytes: number; limit: number; over: boolean; warn: boolean };
}

export function gcWorkbench(opts: { dryRun?: boolean; now?: Date; ephemeralOnly?: boolean } = {}): GcReport {
  const root = workbenchDir();
  const now = opts.now || new Date();
  const nowMs = now.getTime();
  const dry = !!opts.dryRun;
  const { config } = loadConfig();
  const report: GcReport = {
    schema_v: 1,
    dry_run: dry,
    removed: [],
    rotated: [],
    skipped: [],
    kept: 0,
    reclaimed_bytes: 0,
    quota: { bytes: 0, limit: config.quota.root_max_bytes, over: false, warn: false },
  };
  if (!existsSync(root)) return report;

  const rel = (p: string) => relative(root, p).split("\\").join("/");

  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { report.skipped.push({ path: rel(p), reason: "symlink（不跟随、不删）" }); continue; }
      if (st.isDirectory()) { walk(p); continue; }
      const r = rel(p);
      const durable = config.durable.find((x) => matchPattern(r, x.path));
      if (durable) { report.kept++; continue; }
      const eph = config.ephemeral.find((x) => matchPattern(r, x.path));
      if (eph) {
        const ageH = (nowMs - st.mtimeMs) / 3600_000;
        if (eph.ttl_h && ageH > eph.ttl_h) {
          report.removed.push({ path: r, bytes: st.size, reason: `ttl>${eph.ttl_h}h` });
          report.reclaimed_bytes += st.size;
          if (!dry) rmSync(p, { force: true });
          continue;
        }
        if (eph.on_overflow && (eph.max_bytes || eph.max_lines)) {
          const lines = eph.max_lines ? countLines(p) : 0;
          if ((eph.max_bytes && st.size > eph.max_bytes) || (eph.max_lines && lines > eph.max_lines)) {
            report.rotated.push({ path: r, bytes: st.size, reason: `rotate(${lines} 行/${st.size}B)` });
            if (!dry) rotateLines(p, eph.ttl_h, eph.max_lines, nowMs);
            continue;
          }
        }
        report.kept++;
        continue;
      }
      // 白名单之外：可随时清除
      if (opts.ephemeralOnly) { report.kept++; continue; }
      report.removed.push({ path: r, bytes: st.size, reason: "not-whitelisted" });
      report.reclaimed_bytes += st.size;
      if (!dry) rmSync(p, { force: true });
    }
  };
  walk(root);

  // 清空目录（保留根）
  if (!dry) {
    const pruneEmpty = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name);
        pruneEmpty(p);
        try { if (!readdirSync(p).length) rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    };
    pruneEmpty(root);
  }

  // 统计剩余占用（按操作后估算）
  const bytesOf = (dir: string): number => {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) total += bytesOf(p);
      else total += st.size;
    }
    return total;
  };
  report.quota.bytes = dry ? (() => {
    // dry-run：用「当前总量 - 将删除量」估算
    let total = 0;
    for (const r of report.removed) total -= r.bytes;
    let cur = 0;
    try { cur = bytesOf(root); } catch { cur = 0; }
    return Math.max(0, cur + total);
  })() : bytesOf(root);
  report.quota.over = report.quota.bytes > report.quota.limit;
  report.quota.warn = !report.quota.over && report.quota.bytes >= report.quota.limit * config.quota.warn_ratio;
  return report;
}
