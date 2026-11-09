// dia collab —— 会话级协作（M0：送达与可读）
//
// 设计：docs/msg-collab-m0-design.md
// 事实源：~/.dia/collab/ 下「一消息一文件」（tmp + rename）；正文在发送时复制，
// 不再依赖 --body-file 指向的临时目录。旧 `~/.dia/msg` 只读迁移到 legacy/，不猜 session id。
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import * as paths from "./paths.ts";

export type Kind = "question" | "handoff" | "notify" | "reply";
export type State = "pending" | "delivered" | "acked" | "replied" | "needs_info" | "closed" | "escalated";
export type CloseReason = "done" | "dropped" | "duplicate" | "escalated" | "no-follow-on";

const KINDS: Kind[] = ["question", "handoff", "notify", "reply"];
const CLOSE_REASONS: CloseReason[] = ["done", "dropped", "duplicate", "escalated", "no-follow-on"];
const TERMINAL: State[] = ["replied", "closed"];
const MAX_BODY = 256 * 1024;
const INLINE_BODY = 64 * 1024;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ActorRef {
  session_id: string;
  display_name?: string;
  host?: string;
  cwd?: string;
}

export interface MessageV2 {
  schema: 2;
  id: string;
  thread_id: string;
  seq: number;
  from: ActorRef;
  to: ActorRef;
  kind: Kind;
  subject: string;
  body?: string;
  body_ref?: string;
  body_bytes?: number;
  body_missing?: boolean;
  refs?: Record<string, string>;
  requires_reply: boolean;
  deadline?: string;
  hops: number;
  reply_to?: string;
  idempotency_key: string;
  created_at: string;
  state: State;
  delivered_at?: string;
  /** 模型看到（hook/显式回执）的时间；送达三态：delivered → exposed → acked */
  exposed_at?: string;
  /** 首次被处理的时间（ack/reply/close 时若未 delivered 则补写） */
  first_touch_at?: string;
  /** 到达时快照的优先级（0=P0 最高，3=P3），避免任务状态变化回溯改写历史消息 */
  class_snapshot?: number;
  class_why?: string[];
  acked_at?: string;
  replied_at?: string;
  closed_at?: string;
  closure_reason?: CloseReason;
  reply_id?: string;
  transport: "file";
  legacy?: boolean;
  legacy_to?: string;
}

export interface SessionRecord {
  schema: 1;
  session_id: string;
  host: string;
  display_name: string;
  cwd: string;
  started_at: string;
  last_seen: string;
  capabilities: string[];
  address: string;
}

export interface SendOptions {
  from?: string;
  to: string;
  kind?: Kind;
  subject: string;
  body?: string;
  bodyFile?: string;
  refs?: Record<string, string>;
  requiresReply?: boolean;
  deadline?: string;
  threadId?: string;
  replyTo?: string;
  idempotencyKey?: string;
  hops?: number;
  name?: string;
  /** 到达时快照的优先级（0=P0 … 3=P3）；由调用方按发送者任务 eff 计算 */
  classSnapshot?: number;
  classWhy?: string[];
}

export interface InboxOptions {
  unread?: boolean;
  all?: boolean;
  limit?: number;
  sort?: "arrival" | "priority";
  classes?: number[];
}

const root = () => join(paths.diaHome(), "collab");
const sessionsDir = () => join(root(), "sessions");
const inboxRoot = () => join(root(), "inbox");
const legacyRoot = () => join(root(), "legacy");
const bodiesDir = () => join(root(), "bodies");

function now(): string { return new Date().toISOString(); }
function newId(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`; }
function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true, mode: 0o700 }); }

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function writeAtomic(path: string, data: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(2).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

// 跨平台没有 flock；用 O_EXCL 锁文件 + 短重试。进程崩溃留下的锁超过 30s 视为陈旧。
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(name: string, fn: () => T): T {
  const dir = join(root(), ".locks");
  ensureDir(dir);
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
  const lock = join(dir, `${safe}.lock`);
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  // 陈旧判定：有 pid 且进程活着 → 永不判陈旧；进程已死 → 立即回收；老格式（无 pid）→ mtime > 30s
  const stale = () => {
    try {
      const raw = readFileSync(lock, "utf8");
      const info = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      if (info?.pid) { try { process.kill(info.pid, 0); return false; } catch { return true; } }
      return Date.now() - statSync(lock).mtimeMs > 30_000;
    } catch { return false; }
  };
  let fd: number | undefined;
  for (let i = 0; i < 150; i++) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try { if (stale()) rmSync(lock, { force: true }); } catch { /* ignore */ }
      sleep(20);
    }
  }
  if (fd === undefined) throw new Error(`E_LOCK: 获取锁超时（${name}）`);
  try {
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 0o600 }); } catch { /* ignore */ }
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try {
      const info = JSON.parse(readFileSync(lock, "utf8"));
      if (!info?.token || info.token === token) rmSync(lock, { force: true });
    } catch { /* ignore */ }
  }
}

export function normalizeSessionId(raw: string): string {
  const id = String(raw || "").trim();
  if (!SESSION_RE.test(id) || id.includes("..")) throw new Error(`E_SESSION_ID: 非法会话标识 ${id || "(empty)"}`);
  return id;
}

/** 身份解析顺序：--session > DIA_SESSION_ID > OPENCODE_SESSION_ID > 明确报错。
 *  ⚠️ 不按 cwd/标题猜；不打印 env 值（R37）。 */
export function resolveSessionId(explicit?: string): string {
  const id = explicit || process.env.DIA_SESSION_ID || process.env.OPENCODE_SESSION_ID;
  if (!id) throw new Error("E_NO_SESSION: 未找到会话标识（--session / DIA_SESSION_ID / OPENCODE_SESSION_ID）");
  return normalizeSessionId(id);
}

function detectHost(): string {
  if (process.env.OPENCODE_SESSION_ID) return "opencode";
  return "cli";
}

function defaultDisplayName(id: string, host: string): string {
  return `${host}:${id.slice(-6)}`;
}

export function sessionFile(id: string): string { return join(sessionsDir(), `${normalizeSessionId(id)}.json`); }

export function readSession(id: string): SessionRecord | null {
  return readJson<SessionRecord>(sessionFile(id));
}

function actorOf(id: string): ActorRef {
  const rec = readSession(id);
  return {
    session_id: id,
    display_name: rec?.display_name || defaultDisplayName(id, detectHost()),
    host: rec?.host || detectHost(),
    cwd: rec?.cwd,
  };
}

/** 注册/刷新当前会话；只写会话记录，不碰消息。 */
export function whoami(opts: { session?: string; name?: string; cwd?: string } = {}): SessionRecord {
  const id = resolveSessionId(opts.session);
  return withLock(`session-${id}`, () => {
    const prev = readSession(id);
    const host = prev?.host || detectHost();
    const rec: SessionRecord = {
      schema: 1,
      session_id: id,
      host,
      display_name: opts.name || prev?.display_name || defaultDisplayName(id, host),
      cwd: opts.cwd || prev?.cwd || process.cwd(),
      started_at: prev?.started_at || now(),
      last_seen: now(),
      capabilities: ["msg:v2"],
      address: `session:${id}`,
    };
    writeAtomic(sessionFile(id), JSON.stringify(rec, null, 1) + "\n");
    return rec;
  });
}

function messageFile(sessionId: string, id: string): string {
  return join(inboxRoot(), normalizeSessionId(sessionId), `${id}.json`);
}

function listInboxFiles(sessionId: string): string[] {
  const dir = join(inboxRoot(), normalizeSessionId(sessionId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
}

function readAll(sessionId: string): { msg: MessageV2; path: string }[] {
  const dir = join(inboxRoot(), normalizeSessionId(sessionId));
  if (!existsSync(dir)) return [];
  const out: { msg: MessageV2; path: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    const msg = readJson<MessageV2>(path);
    if (msg) out.push({ msg, path });
  }
  // 到达序：解析成 epoch（历史消息可能带 +08:00，字典序会排错），再以 id 稳定兜底
  const ms = (m: MessageV2) => { const t = Date.parse(m.created_at); return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
  return out.sort((a, b) => ms(a.msg) - ms(b.msg) || a.msg.id.localeCompare(b.msg.id));
}

/** 全部 v2 消息（跨收件箱）；stats/观察器用 */
export function allMessages(): MessageV2[] {
  const out: MessageV2[] = [];
  for (const sid of allSessionsWithInbox()) {
    if (!SESSION_RE.test(sid)) continue; // 脏目录容错：不因一个坏目录让全量扫描失败
    try { out.push(...readAll(sid).map((x) => x.msg)); } catch { /* skip */ }
  }
  return out;
}

function allSessionsWithInbox(): string[] {
  if (!existsSync(inboxRoot())) return [];
  return readdirSync(inboxRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

function findIn(sessionId: string, id: string): { msg: MessageV2; path: string } | null {
  return readAll(sessionId).find((x) => x.msg.id === id) || null;
}

function findAny(id: string): { msg: MessageV2; path: string } | null {
  for (const sid of allSessionsWithInbox()) {
    const hit = findIn(sid, id);
    if (hit) return hit;
  }
  for (const hit of legacyAll()) if (hit.msg.id === id) return hit;
  return null;
}

function legacySlug(agent: string): string {
  const base = agent.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "legacy";
  return `${base}-${createHash("sha1").update(agent).digest("hex").slice(0, 6)}`;
}

function legacyAll(): { msg: MessageV2; path: string }[] {
  if (!existsSync(legacyRoot())) return [];
  const out: { msg: MessageV2; path: string }[] = [];
  for (const slug of readdirSync(legacyRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const dir = join(legacyRoot(), slug);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const path = join(dir, f);
      const msg = readJson<MessageV2>(path);
      if (msg) out.push({ msg, path });
    }
  }
  return out.sort((a, b) => a.msg.created_at.localeCompare(b.msg.created_at) || a.msg.seq - b.msg.seq);
}

function threadMessages(threadId: string): MessageV2[] {
  const out: MessageV2[] = [];
  for (const sid of allSessionsWithInbox()) for (const x of readAll(sid)) if (x.msg.thread_id === threadId) out.push(x.msg);
  for (const x of legacyAll()) if (x.msg.thread_id === threadId) out.push(x.msg);
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq);
}

function validateKind(raw?: string): Kind {
  const kind = (raw || "notify") as Kind;
  if (!KINDS.includes(kind)) throw new Error(`E_KIND: 不支持的类型 ${raw}`);
  return kind;
}

function readBody(opts: SendOptions): { body?: string; body_ref?: string; body_bytes: number } {
  if (opts.body && opts.bodyFile) throw new Error("E_USAGE: --body 与 --body-file 只能给一个");
  if (!opts.bodyFile) {
    const bytes = Buffer.byteLength(opts.body || "");
    if (bytes > MAX_BODY) throw new Error(`E_USAGE: body 超过 ${MAX_BODY} 字节，请拆分或引用文件`);
    return { body: opts.body, body_bytes: bytes };
  }
  if (!existsSync(opts.bodyFile)) throw new Error(`E_USAGE: body file 不存在: ${opts.bodyFile}`);
  const buf = readFileSync(opts.bodyFile);
  if (buf.byteLength > MAX_BODY) throw new Error(`E_USAGE: body 超过 ${MAX_BODY} 字节，请拆分或引用文件`);
  return { body: buf.toString("utf8"), body_bytes: buf.byteLength };
}

export function send(opts: SendOptions): MessageV2 {
  const from = resolveSessionId(opts.from);
  const to = normalizeSessionId(opts.to);
  if (!opts.subject) throw new Error("E_USAGE: --subject 必填");
  const kind = validateKind(opts.kind);
  if (opts.deadline && Number.isNaN(new Date(opts.deadline).getTime())) throw new Error(`E_USAGE: 非法 deadline: ${opts.deadline}`);
  whoami({ session: from, name: opts.name });
  const threadId = opts.threadId || newId("th");
  const body = readBody(opts);

  return withLock(`thread-${threadId}`, () => {
    const existing = threadMessages(threadId);
    const seq = existing.length ? Math.max(...existing.map((m) => m.seq)) + 1 : 1;
    const idempotencyKey = opts.idempotencyKey || `${threadId}#${seq}`;
    const dup = existing.find((m) => m.idempotency_key === idempotencyKey && m.to.session_id === to && m.from.session_id === from);
    if (dup) return dup;

    const id = newId("m");
    let bodyRef: string | undefined;
    if (body.body !== undefined && body.body_bytes > INLINE_BODY) {
      ensureDir(bodiesDir());
      const ref = join("bodies", `${id}.md`);
      writeAtomic(join(root(), ref), body.body);
      bodyRef = ref;
    }
    const msg: MessageV2 = {
      schema: 2,
      id,
      thread_id: threadId,
      seq,
      from: actorOf(from),
      to: actorOf(to),
      kind,
      subject: opts.subject,
      body: bodyRef ? undefined : body.body,
      body_ref: bodyRef,
      body_bytes: body.body_bytes,
      refs: opts.refs && Object.keys(opts.refs).length ? opts.refs : undefined,
      requires_reply: opts.requiresReply ?? kind === "question",
      deadline: opts.deadline,
      hops: opts.hops ?? 0,
      reply_to: opts.replyTo,
      idempotency_key: idempotencyKey,
      created_at: now(),
      state: "pending",
      ...(opts.classSnapshot !== undefined ? { class_snapshot: opts.classSnapshot, class_why: opts.classWhy } : {}),
      transport: "file",
    };
    writeAtomic(messageFile(to, id), JSON.stringify(msg, null, 1) + "\n");
    return msg;
  });
}

export function inbox(sessionId: string, opts: InboxOptions = {}): MessageV2[] {
  const id = normalizeSessionId(sessionId);
  let rows = readAll(id).map((x) => x.msg);
  if (opts.unread) rows = rows.filter((m) => m.state === "pending" || m.state === "delivered");
  else if (!opts.all) rows = rows.filter((m) => !TERMINAL.includes(m.state));
  if (opts.classes?.length) rows = rows.filter((m) => opts.classes!.includes(m.class_snapshot ?? 2));
  if (opts.sort === "priority") {
    const ms = (m: MessageV2) => { const t = Date.parse(m.created_at); return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
    rows = rows.slice().sort((a, b) =>
      (a.class_snapshot ?? 2) - (b.class_snapshot ?? 2) || ms(a) - ms(b) || a.id.localeCompare(b.id));
  }
  return opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
}

export function legacyInbox(opts: { limit?: number } = {}): MessageV2[] {
  const rows = legacyAll().map((x) => x.msg);
  return opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
}

export function get(sessionId: string, id: string): MessageV2 {
  const hit = findIn(sessionId, id) || findAny(id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  return hit.msg;
}

export function show(id: string): MessageV2 {
  const hit = findAny(id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  return hit.msg;
}

/** 读取消息正文：内联优先，其次 body_ref（迁移/大正文）。 */
export function bodyOf(m: MessageV2): string {
  if (m.body !== undefined) return m.body;
  if (m.body_ref) {
    // body_ref 来自消息文件（可能是迁移来的脏数据）：必须落在 bodies/ 内，防止路径穿越读任意文件。
    const base = resolve(bodiesDir());
    const path = resolve(root(), m.body_ref);
    if (path !== base && !path.startsWith(base + sep)) return "";
    try { return readFileSync(path, "utf8"); } catch { return ""; }
  }
  return "";
}

function mutate(sessionId: string, id: string, fn: (m: MessageV2) => void): MessageV2 {
  const sid = normalizeSessionId(sessionId);
  return withLock(`msg-${sid}-${id}`, () => {
    const hit = findIn(sid, id);
    if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
    if (hit.msg.legacy) throw new Error(`E_LEGACY: ${id} 是迁移的旧消息，只读`);
    if (hit.msg.to.session_id !== sid) throw new Error(`E_RECIPIENT: ${id} 不属于 ${sid}`);
    fn(hit.msg);
    writeAtomic(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
    return hit.msg;
  });
}

function touchDelivered(m: MessageV2) {
  if (!m.delivered_at) { m.delivered_at = now(); m.first_touch_at = m.delivered_at; }
  if (m.state === "pending") m.state = "delivered";
}

export function markDelivered(sessionId: string, id: string): MessageV2 {
  return mutate(sessionId, id, (m) => { touchDelivered(m); });
}

/** 批量置 delivered：一次锁 + 一次读取，避免 `dia in` 的 O(N^2) 读放大 */
export function markDeliveredBatch(sessionId: string, ids: string[]): number {
  const sid = normalizeSessionId(sessionId);
  if (!ids.length) return 0;
  const want = new Set(ids);
  return withLock(`inbox-${sid}`, () => {
    const at = now();
    let n = 0;
    for (const f of listInboxFiles(sid)) {
      const msg = readJson<MessageV2>(f);
      if (!msg || !want.has(msg.id) || msg.legacy) continue;
      if (msg.delivered_at) continue;
      msg.delivered_at = at; msg.first_touch_at = at;
      if (msg.state === "pending") msg.state = "delivered";
      writeAtomic(f, JSON.stringify(msg, null, 1) + "\n");
      n++;
    }
    return n;
  });
}

/** 模型侧回执（hook/宿主调用）：记录 exposed_at，不改 ack 状态 */
export function markExposed(sessionId: string, ids: string[]): number {
  const sid = normalizeSessionId(sessionId);
  const want = new Set(ids);
  return withLock(`inbox-${sid}`, () => {
    const at = now();
    let n = 0;
    for (const f of listInboxFiles(sid)) {
      const msg = readJson<MessageV2>(f);
      if (!msg || !want.has(msg.id) || msg.legacy) continue;
      if (!msg.delivered_at) { msg.delivered_at = at; msg.first_touch_at = at; }
      if (!msg.exposed_at) { msg.exposed_at = at; n++; }
      if (msg.state === "pending") msg.state = "delivered";
      writeAtomic(f, JSON.stringify(msg, null, 1) + "\n");
    }
    return n;
  });
}

/** `dia out --reply-to` 补记：把原消息置 replied（避免 reply_rate 低估） */
export function markReplied(originalId: string, replyId: string): MessageV2 {
  const hit = findAny(originalId);
  if (!hit) throw new Error(`E_NOT_FOUND: ${originalId}`);
  const sid = hit.msg.to.session_id;
  return mutate(sid, originalId, (m) => {
    if (m.state === "replied" || m.state === "closed") return;
    touchDelivered(m);
    m.state = "replied";
    m.replied_at = now();
    m.reply_id = replyId;
  });
}

export function ack(sessionId: string, id: string): MessageV2 {
  return mutate(sessionId, id, (m) => {
    if (m.state === "acked") return;
    if (m.state !== "pending" && m.state !== "delivered") throw new Error(`E_STATE: ${id} 是 ${m.state}，不能 ack`);
    touchDelivered(m);
    m.state = "acked";
    m.acked_at = now();
  });
}

export function reply(sessionId: string, id: string, body: string, refs?: Record<string, string>): { reply: MessageV2; original: MessageV2 } {
  const idNorm = normalizeSessionId(sessionId);
  return withLock(`reply-${idNorm}-${id}`, () => {
    const hit = findIn(idNorm, id);
    if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
    const o = hit.msg;
    if (o.legacy) throw new Error(`E_LEGACY: ${id} 是迁移的旧消息，无法回复`);
    if (o.state === "replied" || o.state === "closed") throw new Error(`E_STATE: ${id} 已是 ${o.state}，不能重复回复`);
    if (o.hops >= 3) throw new Error("E_HOPS: 同一 thread 已往返 3 次，转人工");
    const maxHops = Math.max(o.hops, ...threadMessages(o.thread_id).map((m) => m.hops));
    const r = send({
      from: idNorm,
      to: o.from.session_id,
      kind: "reply",
      subject: `Re: ${o.subject}`,
      body,
      refs: { ...(o.refs || {}), ...(refs || {}) },
      requiresReply: false,
      threadId: o.thread_id,
      replyTo: o.id,
      hops: maxHops + 1,
    });
    const original = mutate(idNorm, id, (m) => {
      touchDelivered(m);
      m.state = "replied";
      m.replied_at = now();
      m.reply_id = r.id;
    });
    return { reply: r, original };
  });
}

export function close(sessionId: string, id: string, reason: string): MessageV2 {
  const why = reason as CloseReason;
  if (!CLOSE_REASONS.includes(why)) throw new Error(`E_USAGE: --reason 必须是 ${CLOSE_REASONS.join("|")}`);
  return mutate(sessionId, id, (m) => {
    if (m.state === "closed") {
      if (m.closure_reason === why) return;
      throw new Error(`E_STATE: ${id} 已关闭（${m.closure_reason}），不能改成 ${why}`);
    }
    touchDelivered(m);
    m.state = "closed";
    m.closure_reason = why;
    m.closed_at = now();
  });
}

export interface StatsOptions {
  since?: string;
  now?: Date;
  by?: "session" | "pair" | "class";
}

const TERMINAL_STATES = new Set(["replied", "closed"]);

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return Math.round(a[i]);
}

function parseSince(v: string | undefined, now: Date): Date {
  if (!v) return new Date(now.getTime() - 7 * 86400000);
  const m = /^(\d+)([dhm])$/.exec(v.trim());
  if (m) return new Date(now.getTime() - Number(m[1]) * ({ d: 86400000, h: 3600000, m: 60000 }[m[2] as "d" | "h" | "m"]));
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`E_USAGE: 非法 --since ${v}`);
  return new Date(t);
}

const tsOf = (s?: string) => { if (!s) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : t; };

/** 只读聚合：cohort 口径（按 created_at 入窗）+ backlog as-of（当前积压） */
export function messageStats(opts: StatsOptions = {}) {
  const now = opts.now ?? new Date();
  const since = parseSince(opts.since, now);
  const sinceMs = since.getTime(), nowMs = now.getTime();
  const all = allMessages();
  const liveSessions = new Set(readdirSyncSafe(sessionsDir(), ".json").map((f) => f.replace(/\.json$/, "")));

  const rows = all.filter((m) => !m.legacy && m.from.session_id !== m.to.session_id);
  const cohort = rows.filter((m) => {
    const t = tsOf(m.created_at);
    if (t === null || t < sinceMs || t > nowMs) return false;
    if (m.state === "closed" && m.closure_reason === "duplicate") return false;
    return true;
  });

  const lag = (a?: string, b?: string) => { const x = tsOf(a), y = tsOf(b); return x === null || y === null ? null : y - x; };
  const deliverLags = cohort.map((m) => lag(m.created_at, m.delivered_at)).filter((x): x is number => x !== null && x >= 0);
  const replyTargets = cohort.filter((m) => m.requires_reply && m.kind !== "reply");
  const replyLags = replyTargets.map((m) => lag(m.created_at, m.replied_at)).filter((x): x is number => x !== null && x >= 0);
  const ackTargets = cohort.filter((m) => m.requires_reply || m.kind === "handoff");
  const backlogs = rows.filter((m) => !TERMINAL_STATES.has(m.state));

  const byKey = (m: MessageV2) => opts.by === "pair" ? `${m.from.session_id}→${m.to.session_id}` : opts.by === "class" ? `P${m.class_snapshot ?? 2}` : m.to.session_id;
  const groups: Record<string, any> = {};
  for (const m of cohort) {
    const k = byKey(m);
    const g = groups[k] ?? (groups[k] = { key: k, total: 0, delivered: 0, exposed: 0, acked: 0, replied: 0, reply_n: 0, reply_lags: [] as number[] });
    g.total++;
    if (m.delivered_at) g.delivered++;
    if (m.exposed_at) g.exposed++;
    if (m.acked_at) g.acked++;
    if (m.replied_at) { g.replied++; const l = lag(m.created_at, m.replied_at); if (l !== null && l >= 0) { g.reply_n++; g.reply_lags.push(l); } }
  }

  return {
    schema: 1,
    as_of: new Date(nowMs).toISOString(),
    since: since.toISOString(),
    cohort: {
      total: cohort.length,
      deliver_lag_ms: { n: deliverLags.length, median: percentile(deliverLags, 50), p90: percentile(deliverLags, 90) },
      delivered_rate: cohort.length ? round(cohort.filter((m) => m.delivered_at).length / cohort.length) : null,
      exposed_rate: cohort.length ? round(cohort.filter((m) => m.exposed_at).length / cohort.length) : null,
      ack_rate: ackTargets.length ? round(ackTargets.filter((m) => m.acked_at).length / ackTargets.length) : null,
      reply_rate: replyTargets.length ? round(replyTargets.filter((m) => m.replied_at).length / replyTargets.length) : null,
      reply_latency_ms: { n: replyLags.length, median: percentile(replyLags, 50), p90: percentile(replyLags, 90), censored: replyTargets.length - replyLags.length },
    },
    backlog: {
      count: backlogs.length,
      oldest_age_ms: backlogs.length ? nowMs - Math.min(...backlogs.map((m) => tsOf(m.created_at) ?? nowMs)) : 0,
      orphan: backlogs.filter((m) => !liveSessions.has(m.to.session_id)).length,
      by_class: countBy(backlogs, (m) => `P${m.class_snapshot ?? 2}`),
    },
    groups: Object.values(groups).map((g: any) => ({ ...g, reply_lags: undefined, reply_latency_ms: percentile(g.reply_lags, 50) })),
    notes: ["reply_latency 仅统计已回复样本（右删失见 censored）", "delivered = dia in 成功输出；exposed = 宿主回执（--expose）"],
  };
}

function round(x: number): number { return Math.round(x * 1000) / 1000; }
function countBy<T>(xs: T[], k: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) { const key = k(x); out[key] = (out[key] || 0) + 1; }
  return out;
}
function readdirSyncSafe(dir: string, suffix: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith(suffix)); } catch { return []; }
}

/** 旧 ~/.dia/msg → ~/.dia/collab/legacy：正文复制，不猜 session id，幂等。 */
export function migrateLegacy(opts: { dryRun?: boolean } = {}): { total: number; migrated: number; skipped: number; messages: MessageV2[] } {
  const oldRoot = join(paths.diaHome(), "msg");
  if (!existsSync(oldRoot)) return { total: 0, migrated: 0, skipped: 0, messages: [] };
  const rows: MessageV2[] = [];
  let migrated = 0, skipped = 0, total = 0;
  for (const agent of readdirSync(oldRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const dir = join(oldRoot, agent, "inbox");
    if (!existsSync(dir)) continue;
    const slug = legacySlug(agent);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      total++;
      const old = readJson<any>(join(dir, f));
      if (!old?.id) { skipped++; continue; }
      const legacyId = String(old.id);
      if (!SESSION_RE.test(legacyId) || legacyId.includes("..")) { skipped++; continue; }
      const target = join(legacyRoot(), slug, `${legacyId}.json`);
      if (existsSync(target)) { skipped++; continue; }
      let body = old.body as string | undefined;
      let bodyMissing = false;
      let bodyBytes = Buffer.byteLength(body || "");
      if (!body && old.body_file) {
        const abs = resolve(String(old.body_file));
        const allowed = [resolve(oldRoot), resolve(tmpdir())].some((base) => abs === base || abs.startsWith(base + sep));
        if (!allowed) {
          bodyMissing = true;
        } else if (existsSync(abs)) {
          const buf = readFileSync(abs);
          bodyBytes = buf.byteLength;
          if (bodyBytes > MAX_BODY) { skipped++; continue; }
          body = buf.toString("utf8");
        } else {
          bodyMissing = true;
        }
      }
      const msg: MessageV2 = {
        schema: 2,
        id: String(old.id),
        thread_id: String(old.thread_id || newId("th")),
        seq: Number(old.seq || 1),
        from: { session_id: String(old.from || "legacy:unknown"), display_name: String(old.from || "legacy:unknown") },
        to: { session_id: `legacy:${slug}`, display_name: agent },
        kind: KINDS.includes(old.kind) ? old.kind : "notify",
        subject: String(old.subject || "(no subject)"),
        body,
        body_bytes: bodyBytes,
        body_missing: bodyMissing || undefined,
        refs: old.refs,
        requires_reply: !!old.requires_reply,
        deadline: old.deadline,
        hops: Number(old.hops || 0),
        idempotency_key: String(old.idempotency_key || `${old.thread_id}#${old.seq}`),
        created_at: String(old.created_at || now()),
        state: "pending",
        transport: "file",
        legacy: true,
        legacy_to: agent,
      };
      rows.push(msg);
      if (opts.dryRun) continue;
      writeAtomic(target, JSON.stringify(msg, null, 1) + "\n");
      migrated++;
    }
  }
  return { total, migrated, skipped, messages: rows };
}

export function stats(sessionId: string): { total: number; unread: number; pending: number } {
  const rows = readAll(sessionId).map((x) => x.msg);
  return {
    total: rows.length,
    unread: rows.filter((m) => m.state === "pending" || m.state === "delivered").length,
    pending: rows.filter((m) => m.state === "pending").length,
  };
}

export const limits = { MAX_BODY, INLINE_BODY };
