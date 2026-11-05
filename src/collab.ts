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
}

export interface InboxOptions {
  unread?: boolean;
  all?: boolean;
  limit?: number;
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

function withLock<T>(name: string, fn: () => T): T {
  const dir = join(root(), ".locks");
  ensureDir(dir);
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
  const lock = join(dir, `${safe}.lock`);
  let fd: number | undefined;
  for (let i = 0; i < 150; i++) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true }); } catch { /* ignore */ }
      sleep(20);
    }
  }
  if (fd === undefined) throw new Error(`E_LOCK: 获取锁超时（${name}）`);
  try { return fn(); } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { rmSync(lock, { force: true }); } catch { /* ignore */ }
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
  return out.sort((a, b) =>
    a.msg.created_at.localeCompare(b.msg.created_at) || a.msg.seq - b.msg.seq);
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

export function markDelivered(sessionId: string, id: string): MessageV2 {
  return mutate(sessionId, id, (m) => {
    if (m.state === "pending") { m.state = "delivered"; m.delivered_at = now(); }
  });
}

export function ack(sessionId: string, id: string): MessageV2 {
  return mutate(sessionId, id, (m) => {
    if (m.state === "acked") return;
    if (m.state !== "pending" && m.state !== "delivered") throw new Error(`E_STATE: ${id} 是 ${m.state}，不能 ack`);
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
    m.state = "closed";
    m.closure_reason = why;
    m.closed_at = now();
  });
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
