// dia msg —— 跨 agent 消息（文件邮箱为持久化事实源，tmux/ACP 只是注入通道）
//
// 设计：docs/compose/spec/levm-agent-roles-design.md §2
//   · 一消息一文件（tmp + rename），不用共享 append JSONL（跨 4KB 会撕裂）
//   · 幂等键 = thread_id + seq；同 key 重复 send 返回原消息，不重复投递
//   · 状态机：pending → delivered → acked → replied → closed；超时 → escalated
//   · 传输事实与协议自述分开：本模块只记 durable 状态；tmux/ACP 投递结果另行回写
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as paths from "./paths.ts";

const dataDir = () => paths.diaHome();
export const msgRoot = () => paths.msgRoot();

export type MsgKind = "question" | "handoff" | "notify" | "reply";
export type MsgState = "pending" | "delivered" | "acked" | "replied" | "needs_info" | "closed" | "escalated";
const TERMINAL: MsgState[] = ["replied", "needs_info", "closed", "escalated"];
export const isTerminal = (s: MsgState) => TERMINAL.includes(s);
const KINDS: MsgKind[] = ["question", "handoff", "notify", "reply"];

export interface Message {
  id: string;
  thread_id: string;
  seq: number;
  from: string;
  to: string;
  kind: MsgKind;
  subject: string;
  body?: string;
  body_file?: string;
  refs?: Record<string, string>;
  requires_reply: boolean;
  deadline?: string;
  hops: number;
  idempotency_key: string;
  created_at: string;
  state: MsgState;
  transport?: string;
  ack_at?: string;
  replied_at?: string;
  reply_id?: string;
  escalated_at?: string;
}

export interface SendOptions {
  from: string;
  to: string;
  kind: MsgKind;
  subject: string;
  body?: string;
  bodyFile?: string;
  refs?: Record<string, string>;
  requiresReply?: boolean;
  deadline?: string;
  threadId?: string;
  hops?: number;
}

const dirOf = (agent: string) => join(msgRoot(), agent, "inbox");

function atomicWrite(path: string, data: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(2).toString("hex")}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readAll(agent: string): Message[] {
  const dir = dirOf(agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf8")) as Message; } catch { return null; }
    })
    .filter((m): m is Message => !!m)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function writeMsg(m: Message) {
  atomicWrite(join(dirOf(m.to), `${m.id}.json`), JSON.stringify(m, null, 1) + "\n");
}

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** 所有 agent 目录（收发双方都可能在不同目录） */
function allInboxes(): { agent: string; messages: Message[] }[] {
  const root = msgRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ agent: e.name, messages: readAll(e.name) }));
}

export function send(opts: SendOptions): Message {
  if (!KINDS.includes(opts.kind)) throw new Error(`E_KIND: 不支持的类型 ${opts.kind}`);
  if (!opts.from || !opts.to) throw new Error("E_USAGE: from/to 必填");
  if (!opts.subject) throw new Error("E_USAGE: --subject 必填");
  if (opts.body && opts.bodyFile) throw new Error("E_USAGE: --body 与 --body-file 只能给一个");
  if (opts.bodyFile && !existsSync(opts.bodyFile)) throw new Error(`E_USAGE: body file 不存在: ${opts.bodyFile}`);

  const threadId = opts.threadId || newId("th");
  const existing = [...readAll(opts.to), ...readAll(opts.from)].filter((m) => m.thread_id === threadId);
  const seq = existing.length ? Math.max(...existing.map((m) => m.seq)) + 1 : 1;
  const idempotencyKey = `${threadId}#${seq}`;
  const dup = existing.find((m) => m.idempotency_key === idempotencyKey && m.to === opts.to);
  if (dup) return dup; // 幂等：同 thread+seq 不重复投递

  const m: Message = {
    id: newId("m"),
    thread_id: threadId,
    seq,
    from: opts.from,
    to: opts.to,
    kind: opts.kind,
    subject: opts.subject,
    body: opts.body,
    body_file: opts.bodyFile,
    refs: opts.refs,
    requires_reply: opts.requiresReply ?? opts.kind === "question",
    deadline: opts.deadline,
    hops: opts.hops ?? 0,
    idempotency_key: idempotencyKey,
    created_at: new Date().toISOString(),
    state: "pending",
  };
  writeMsg(m);
  return m;
}

export function get(agent: string, id: string): Message {
  const hit = findInbox(agent, id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  return hit.msg;
}

export function inbox(agent: string, opts: { unread?: boolean } = {}): Message[] {
  const all = readAll(agent);
  const active = all.filter((m) => m.state !== "closed");
  return opts.unread ? active.filter((m) => m.state === "pending" && m.ack_at === undefined) : active;
}

function findInbox(agent: string, id: string): { msg: Message; path: string } | null {
  const dir = dirOf(agent);
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as Message;
      if (m.id === id) return { msg: m, path: join(dir, f) };
    } catch {}
  }
  return null;
}

export function ack(agent: string, id: string): Message {
  const hit = findInbox(agent, id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  hit.msg.state = hit.msg.state === "pending" || hit.msg.state === "delivered" ? "acked" : hit.msg.state;
  hit.msg.ack_at = new Date().toISOString();
  atomicWrite(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
  return hit.msg;
}

/** 标记传输层已投递（tmux/ACP 回写；send-keys 退出码 0 不算） */
export function markDelivered(agent: string, id: string, transport: string): Message {
  const hit = findInbox(agent, id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  if (hit.msg.state === "pending") hit.msg.state = "delivered";
  hit.msg.transport = transport;
  atomicWrite(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
  return hit.msg;
}

export function reply(agent: string, id: string, body: string, opts: { refs?: Record<string, string> } = {}): { reply: Message; original: Message } {
  const hit = findInbox(agent, id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  const o = hit.msg;
  if (o.hops >= 3) throw new Error("E_HOPS: 同一 thread 已往返 3 次，转人工");
  const r = send({
    from: agent,
    to: o.from,
    kind: "reply",
    subject: `Re: ${o.subject}`,
    body,
    refs: { ...(o.refs ?? {}), ...(opts.refs ?? {}) },
    requiresReply: false,
    threadId: o.thread_id,
    hops: o.hops + 1,
  });
  o.state = "replied";
  o.replied_at = new Date().toISOString();
  o.reply_id = r.id;
  atomicWrite(hit.path, JSON.stringify(o, null, 1) + "\n");
  return { reply: r, original: o };
}

export function thread(threadId: string): Message[] {
  return allInboxes()
    .flatMap((e) => e.messages)
    .filter((m) => m.thread_id === threadId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** deadline 超时 → escalated（由 dia-job periodic 调用；不是常驻进程） */
export function escalateOverdue(now = new Date()): Message[] {
  const out: Message[] = [];
  for (const { agent, messages } of allInboxes()) {
    for (const m of messages) {
      if (!m.deadline) continue;
      if (["replied", "needs_info", "closed", "escalated"].includes(m.state)) continue;
      if (new Date(m.deadline).getTime() > now.getTime()) continue;
      const hit = findInbox(agent, m.id);
      if (!hit) continue;
      hit.msg.state = "escalated";
      hit.msg.escalated_at = now.toISOString();
      atomicWrite(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
      out.push(hit.msg);
    }
  }
  return out;
}

/** 证据/信息不足：合法终态，调用方据此去补而不是重投 */
export function needsInfo(agent: string, id: string, reason: string): Message {
  const hit = findInbox(agent, id);
  if (!hit) throw new Error(`E_NOT_FOUND: ${id}`);
  hit.msg.state = "needs_info";
  (hit.msg as any).needs_info_reason = reason;
  (hit.msg as any).needs_info_at = new Date().toISOString();
  atomicWrite(hit.path, JSON.stringify(hit.msg, null, 1) + "\n");
  return hit.msg;
}

/** 跨收件箱按 id 查找（status 命令用） */
export function find(id: string): { agent: string; msg: Message } | null {
  for (const { agent, messages } of allInboxes()) {
    const m = messages.find((x) => x.id === id);
    if (m) return { agent, msg: m };
  }
  return null;
}

/** 卡住的消息：非终态且超过 minutes 分钟没动 */
export function stuck(minutes = 30, now = new Date()): Message[] {
  const cutoff = now.getTime() - minutes * 60_000;
  return allInboxes()
    .flatMap((e) => e.messages)
    .filter((m) => !isTerminal(m.state) && new Date(m.created_at).getTime() < cutoff);
}

export function agents(): string[] {
  const root = msgRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && statSync(join(root, e.name)).isDirectory()).map((e) => e.name);
}
