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
import * as events from "./msg-events.ts";
import { paneBinding, pushPointer } from "./tmux.ts";

export type Kind = "question" | "handoff" | "notify" | "reply";
export type State = "pending" | "delivered" | "acked" | "replied" | "needs_info" | "closed" | "escalated";
export type CloseReason = "done" | "dropped" | "duplicate" | "escalated" | "no-follow-on";

const KINDS: Kind[] = ["question", "handoff", "notify", "reply"];
const CLOSE_REASONS: CloseReason[] = ["done", "dropped", "duplicate", "escalated", "no-follow-on"];
const TERMINAL: State[] = ["replied", "closed", "escalated"];
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
  transport: "file" | "tmux" | "acp" | "webhook";
  /** 传输层确认注入的时间（≠ 被模型看到；exposed_at 才是） */
  injected_at?: string;
  /** 本次发送的投递结果（不持久化语义，仅返回给调用方显示） */
  notify?: { channel: "tmux" | "mailbox-only"; reason?: string };
  /** 投递尝试（P2：重投/复盘用） */
  attempts?: number;
  last_attempt_at?: string;
  next_retry_at?: string;
  escalated_at?: string;
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
  /** tmux 可达性（可失效的提示通道；身份以 pane+pid+cwd 指纹校验） */
  pane?: string;
  pane_pid?: string;
  pane_start?: string;
  pane_cwd?: string;
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

/** 全部会话记录（坐席/在线判定用；脏文件容错跳过） */
export function listSessions(): SessionRecord[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: SessionRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = readJson<SessionRecord>(join(dir, f));
    if (rec && SESSION_RE.test(rec.session_id)) out.push(rec);
  }
  return out.sort((a, b) => a.session_id.localeCompare(b.session_id));
}

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
      ...(paneBinding() || {}),
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

  const saved = withLock(`thread-${threadId}`, () => {
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
    try {
      writeAtomic(messageFile(to, id), JSON.stringify(msg, null, 1) + "\n");
    } catch (e: any) {
      events.log({ event: "send.failed", msg_id: id, thread_id: threadId, actor: from, error_code: e?.code || "E_WRITE" });
      throw e;
    }
    events.log({ event: "send.accepted", msg_id: id, thread_id: threadId, actor: from, to_state: "pending", transport: "file" });
    return msg;
  });

  // push 只做「叫醒一轮」：失败/无 pane 都不阻断发送，结果只记录（不写 acked）
  return notify(saved);
}

/** 记录一次投递尝试（失败按 60s×2^n 退避，封顶 10min；成功后清空退避）。 */
function recordAttempt(msg: MessageV2, attempt: number, errorCode?: string) {
  const hit = findIn(msg.to.session_id, msg.id);
  if (!hit || hit.msg.legacy) return;
  hit.msg.attempts = attempt;
  hit.msg.last_attempt_at = now();
  if (errorCode) hit.msg.next_retry_at = new Date(Date.now() + Math.min(600_000, 60_000 * 2 ** (attempt - 1))).toISOString();
  else delete hit.msg.next_retry_at;
  writeAtomic(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
}

/** 尽力注入一次消息指针；返回带 notify 结果的消息快照。 */
function notify(msg: MessageV2): MessageV2 {
  const rec = readSession(msg.to.session_id);
  const mark = (channel: "tmux" | "mailbox-only", reason?: string): MessageV2 => {
    msg.notify = { channel, reason: reason || undefined };
    return msg;
  };
  if (rec?.pane) {
    const r = tryTmux(msg, rec.pane);
    if (r.ok) return r.msg;
    // tmux 失败（忙/离线/未验证）但仍配置了 webhook → 继续走 webhook
    if (!process.env.DIA_MSG_WEBHOOK_URL) return r.msg;
  }
  if (process.env.DIA_MSG_WEBHOOK_URL) return tryWebhook(msg, process.env.DIA_MSG_WEBHOOK_URL);
  return mark("mailbox-only", "no-pane");
}

function tryTmux(msg: MessageV2, pane: string): { ok: boolean; msg: MessageV2 } {
  const attempt = (msg.attempts || 0) + 1;
  events.log({ event: "inject.attempted", msg_id: msg.id, thread_id: msg.thread_id, transport: "tmux", attempt });
  const r = pushPointer(pane, { id: msg.id, subject: msg.subject, session: msg.to.session_id });
  if (!r.ok) {
    events.log({ event: "inject.failed", msg_id: msg.id, thread_id: msg.thread_id, transport: "tmux", attempt, error_code: r.code });
    recordAttempt(msg, attempt, r.code);
    msg.notify = { channel: "mailbox-only", reason: r.code };
    return { ok: false, msg };
  }
  events.log({ event: "inject.verified", msg_id: msg.id, thread_id: msg.thread_id, transport: "tmux", attempt });
  recordAttempt(msg, attempt);
  const hit = findIn(msg.to.session_id, msg.id);
  if (hit && !hit.msg.legacy && !hit.msg.injected_at) {
    hit.msg.injected_at = now();
    hit.msg.transport = "tmux";
    writeAtomic(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
  }
  msg.notify = { channel: "tmux" };
  return { ok: true, msg };
}

/** P3：webhook transport（独立消息服务/网关）。2xx 才算注入成功；失败只记录不重试。 */
function tryWebhook(msg: MessageV2, url: string): MessageV2 {
  const attempt = (msg.attempts || 0) + 1;
  events.log({ event: "inject.attempted", msg_id: msg.id, thread_id: msg.thread_id, transport: "webhook", attempt });
  try {
    const res = spawnSync("curl", ["-sS", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", url,
      "-H", "content-type: application/json", "-d", JSON.stringify({ id: msg.id, thread: msg.thread_id, from: msg.from.session_id, to: msg.to.session_id, subject: msg.subject, kind: msg.kind })],
      { encoding: "utf8" });
    const code = Number((res.stdout || "").trim());
    if (res.status === 0 && code >= 200 && code < 300) {
      events.log({ event: "inject.verified", msg_id: msg.id, thread_id: msg.thread_id, transport: "webhook", attempt });
      recordAttempt(msg, attempt);
      msg.notify = { channel: "tmux" as any }; // 语义：已通过外部通道叫醒
      return msg;
    }
    events.log({ event: "inject.failed", msg_id: msg.id, thread_id: msg.thread_id, transport: "webhook", attempt, error_code: `E_WEBHOOK_${code || res.status}` });
    recordAttempt(msg, attempt, `E_WEBHOOK`);
    msg.notify = { channel: "mailbox-only", reason: `E_WEBHOOK_${code || res.status}` };
    return msg;
  } catch (e: any) {
    events.log({ event: "inject.failed", msg_id: msg.id, thread_id: msg.thread_id, transport: "webhook", attempt, error_code: "E_WEBHOOK" });
    recordAttempt(msg, attempt, "E_WEBHOOK");
    msg.notify = { channel: "mailbox-only", reason: "E_WEBHOOK" };
    return msg;
  }
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
      events.log({
        event: "read.observed", msg_id: msg.id, thread_id: msg.thread_id, actor: sid,
        from_state: "pending", to_state: "delivered",
        latency_ms: Math.max(0, Date.parse(at) - Date.parse(msg.created_at)),
      });
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
      events.log({ event: "context.exposed", msg_id: msg.id, thread_id: msg.thread_id, actor: sid, to_state: "exposed" });
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
    events.log({ event: "acked", msg_id: id, thread_id: m.thread_id, actor: normalizeSessionId(sessionId), to_state: "acked", latency_ms: Math.max(0, Date.now() - Date.parse(m.delivered_at || m.created_at)) });
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
      events.log({ event: "replied", msg_id: id, thread_id: m.thread_id, actor: idNorm, from_state: "acked", to_state: "replied", latency_ms: Math.max(0, Date.now() - Date.parse(m.created_at)) });
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
    events.log({ event: "closed", msg_id: id, thread_id: m.thread_id, actor: normalizeSessionId(sessionId), to_state: "closed", error_code: why });
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

/** 超时升级：requires_reply 30min / 其它 4h；只改状态 + 事件，不发正文。 */
export function escalateDue(opts: { now?: Date; ackTtlMs?: number; ttlMs?: number } = {}): { id: string; session: string; age_ms: number }[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ackTtl = opts.ackTtlMs ?? Number(process.env.DIA_MSG_ACK_TTL_MS || 30 * 60_000);
  const ttl = opts.ttlMs ?? Number(process.env.DIA_MSG_TTL_MS || 4 * 3600_000);
  const out: { id: string; session: string; age_ms: number }[] = [];
  for (const rec of listSessions()) {
    const sid = rec.session_id;
    for (const f of listInboxFiles(sid)) {
      const m = readJson<MessageV2>(f);
      if (!m || m.legacy || TERMINAL.includes(m.state) || m.state === "escalated") continue;
      const created = Date.parse(m.created_at);
      if (Number.isNaN(created)) continue;
      const limit = m.requires_reply ? ackTtl : ttl;
      const age = nowMs - created;
      if (age <= limit) continue;
      mutate(sid, m.id, (x) => {
        x.state = "escalated";
        x.escalated_at = now();
        events.log({ event: "escalated", msg_id: x.id, thread_id: x.thread_id, actor: "escalate-due", to_state: "escalated", latency_ms: age });
      });
      out.push({ id: m.id, session: sid, age_ms: age });
    }
  }
  return out;
}

/** 到期重投：只挑「还没注入成功、未终态、过了 next_retry_at、attempts<3」的消息。 */
export function retryDue(opts: { now?: Date; max?: number } = {}): { id: string; session: string; channel: string; reason?: string }[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxAttempts = opts.max ?? 3;
  const out: { id: string; session: string; channel: string; reason?: string }[] = [];
  for (const rec of listSessions()) {
    const sid = rec.session_id;
    for (const f of listInboxFiles(sid)) {
      const m = readJson<MessageV2>(f);
      if (!m || m.legacy || TERMINAL.includes(m.state) || m.state === "escalated") continue;
      if (m.injected_at) continue;
      if ((m.attempts || 0) >= maxAttempts) continue;
      const next = m.next_retry_at ? Date.parse(m.next_retry_at) : 0;
      if (next && next > nowMs) continue;
      const r = notify(m);
      out.push({ id: m.id, session: sid, channel: r.notify?.channel || "mailbox-only", reason: r.notify?.reason });
    }
  }
  return out;
}
