// dia workbench —— track 意图写入（M2 核心）
//
// 设计：docs/design/workbench.md §2.2（状态机）、§3.1（事件）、§6.1（绑定约束）
// 约定：
//   · 本文件只做「校验 + 追加事件」；折叠状态一律复用 store.foldTracks()（不做第二套折叠）
//   · 所有写走 store.appendTrack（它自己加锁），本文件不直接读写文件
//   · 校验与追加之间存在 TOCTOU 窗口：workbench 是 advisory 工具，不做跨进程事务
//   · 不自动改派会话（会话死亡只出 drift 建议，必须显式 handoff）

import { appendTrack, foldTracks, trackId } from "./store.ts";
import { drainRoutes } from "../collab-route.ts";
import type { SessionRole, Track, TrackStatus, WaitingOn } from "./schema.ts";

export const TRACK_STATUSES: TrackStatus[] = ["open", "active", "paused", "blocked", "awaiting_human", "done", "abandoned"];
const CLOSED: ReadonlySet<TrackStatus> = new Set<TrackStatus>(["done", "abandoned"]);
const WAITING_KINDS: Array<WaitingOn["kind"]> = ["human", "session", "mr", "dep", "date"];

export const isTrackClosed = (t: Track): boolean => CLOSED.has(t.status);

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** bind/handoff 后尝试把该 track 的未投递消息出队（best-effort，失败不影响绑定）。 */
function tryDrain(id: string): void {
  try { drainRoutes({ track: id }); } catch { /* 出队失败留给 `dia msg retry --queue` */ }
}

/** repo 归一：去空白、去首尾 `/`、去尾部 `.git`（保持完整 group 路径）。 */
export function normalizeRepo(repo: string): string {
  return String(repo || "").trim().replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
}

const repoSig = (repo: string[]) => [...uniq(repo.map(normalizeRepo))].sort().join(",");

function getTrackOrThrow(id: string): Track {
  const t = getTrack(id);
  if (!t) throw new Error(`E_TRACK_NOT_FOUND: ${id}`);
  return t;
}

function assertOpen(t: Track): void {
  if (isTrackClosed(t)) throw new Error(`E_TRACK_CLOSED: ${t.id} 已关闭（${t.status}）`);
}

/** track 当前的活跃 lead（未解绑）。 */
export function leadOf(t: Track): string | undefined {
  return t.sessions.find((s) => s.role === "lead" && !s.unbound_at)?.session_id;
}

/** 某会话作为 lead 的活跃 track 列表。 */
function leadTracksOf(session: string, exceptId?: string): Track[] {
  return listTracks().filter((t) => !isTrackClosed(t) && t.id !== exceptId && leadOf(t) === session);
}

// ── 读 ────────────────────────────────────────────────────────────────────────

export function getTrack(id: string): Track | null {
  return foldTracks().tracks.find((t) => t.id === id) ?? null;
}

export function listTracks(opts: { status?: TrackStatus | TrackStatus[] } = {}): Track[] {
  const want = opts.status === undefined ? undefined : Array.isArray(opts.status) ? opts.status : [opts.status];
  const tracks = foldTracks().tracks;
  return want ? tracks.filter((t) => want.includes(t.status)) : tracks;
}

// ── 写：open ─────────────────────────────────────────────────────────────────

export interface OpenTrackInput {
  title: string;
  goal?: string;
  repo?: string[];
  prio?: string;
  owner?: string;
  next?: string;
  remind_at?: string;
  stage?: string;
  status?: TrackStatus;
}

/** 开一条 task 线。同 `title + repo 集合` 已有未关闭 track → E_TRACK_DUP（带既有 id）。 */
export function openTrack(input: OpenTrackInput, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const title = String(input?.title || "").trim();
  if (!title) throw new Error("E_USAGE: track open 需要 title");
  if (input.status && !TRACK_STATUSES.includes(input.status)) throw new Error(`E_USAGE: 未知 status: ${input.status}`);
  const repo = uniq((input.repo || []).map(normalizeRepo));
  const sig = repoSig(repo);
  const dup = listTracks().find((t) => !isTrackClosed(t) && t.title === title && repoSig(t.repo) === sig);
  if (dup) throw new Error(`E_TRACK_DUP: 已存在 ${dup.id}`);

  const id = trackId(title, repo);
  appendTrack({
    ts,
    event: "open",
    id,
    title,
    goal: input.goal,
    status: input.status,
    stage: input.stage,
    next: input.next,
    repo: repo.length ? repo : undefined,
    prio: input.prio,
    owner: input.owner,
    remind_at: input.remind_at,
  });
  const t = getTrack(id);
  if (!t) throw new Error(`E_TRACK: 追加 open 后折叠不到 ${id}`);
  return t;
}

// ── 写：绑定 / 解绑 / 交接 ───────────────────────────────────────────────────

export interface BindInput { session: string; role?: SessionRole; host?: string }

/**
 * 绑定会话。约束（§6.1）：
 *   · 一个活跃 track 只能有 1 个未解绑 lead
 *   · 一个会话最多做 1 个活跃 track 的 lead（可以是多个 track 的 worker）
 * 首次绑定会把 open 推进为 active（状态机 open → active）。
 */
export function bindTrack(id: string, input: BindInput, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  assertOpen(t);
  const session = String(input?.session || "").trim();
  if (!session) throw new Error("E_USAGE: track bind 需要 --session");
  const role: SessionRole = input.role || "lead";
  if (!["lead", "worker", "reviewer"].includes(role)) throw new Error(`E_USAGE: 未知 role: ${role}`);

  const already = t.sessions.find((s) => s.session_id === session && !s.unbound_at);
  if (already) {
    if (already.role === role) return t; // 幂等：重复 bind 不报错、不重复记账
    throw new Error(`E_TRACK_AMBIGUOUS: ${session} 已以 ${already.role} 绑定 ${id}；先 unbind 再换 role`);
  }

  if (role === "lead") {
    const lead = leadOf(t);
    if (lead && lead !== session) throw new Error(`E_TRACK_AMBIGUOUS: ${id} 已有 lead ${lead}（先 handoff 或 unbind）`);
    const other = leadTracksOf(session, id);
    if (other.length) throw new Error(`E_TRACK_AMBIGUOUS: ${session} 已是 ${other.map((x) => x.id).join(", ")} 的 lead；一个会话最多 1 个活跃 track 的 lead`);
  }

  appendTrack({ ts, event: "bind", id, session, role, host: input.host });
  if (t.status === "open") appendTrack({ ts, event: "stage", id, status: "active" });
  tryDrain(id);
  return getTrackOrThrow(id);
}

export function unbind(id: string, opts: { session: string; now?: Date }): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  const session = String(opts.session || "").trim();
  if (!session) throw new Error("E_USAGE: track unbind 需要 --session");
  if (!t.sessions.some((s) => s.session_id === session && !s.unbound_at)) {
    throw new Error(`E_TRACK_BIND: ${session} 没有活跃绑定 ${id}`);
  }
  appendTrack({ ts, event: "unbind", id, session });
  return getTrackOrThrow(id);
}

/** 显式交接：解绑 from（lead）→ 绑定 to（lead）。不自动改派。 */
export function handoff(id: string, input: { from: string; to: string; reason: string }, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  assertOpen(t);
  const from = String(input?.from || "").trim();
  const to = String(input?.to || "").trim();
  const reason = String(input?.reason || "").trim();
  if (!from || !to) throw new Error("E_USAGE: track handoff 需要 --from 与 --to");
  if (!reason) throw new Error("E_USAGE: track handoff 需要 --reason");
  if (from === to) throw new Error(`E_USAGE: handoff 的 from 与 to 不能相同（${from}）`);
  if (!t.sessions.some((s) => s.session_id === from && !s.unbound_at)) {
    throw new Error(`E_TRACK_BIND: ${from} 没有活跃绑定 ${id}`);
  }
  const other = leadTracksOf(to, id);
  if (other.length) throw new Error(`E_TRACK_AMBIGUOUS: ${to} 已是 ${other.map((x) => x.id).join(", ")} 的 lead；一个会话最多 1 个活跃 track 的 lead`);

  appendTrack({ ts, event: "handoff", id, from, to, reason });
  tryDrain(id);
  return getTrackOrThrow(id);
}

// ── 写：状态 / 下一步 / 任务 / 关闭 ───────────────────────────────────────────

export interface StageInput { status?: TrackStatus; stage?: string; reason?: string; next?: string }

/** 人工推状态。done/abandoned 只能走 close（避免看板自编终态）。 */
export function stage(id: string, input: StageInput, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  assertOpen(t);
  if (!input || (input.status === undefined && input.stage === undefined && input.reason === undefined && input.next === undefined)) {
    throw new Error("E_USAGE: track stage 至少给一个 --status/--stage/--reason/--next");
  }
  if (input.status !== undefined) {
    if (!TRACK_STATUSES.includes(input.status)) throw new Error(`E_USAGE: 未知 status: ${input.status}`);
    if (CLOSED.has(input.status)) throw new Error(`E_USAGE: 结束 track 请用 close（${input.status}）`);
  }
  appendTrack({ ts, event: "stage", id, status: input.status, stage: input.stage, reason: input.reason, next: input.next });
  return getTrackOrThrow(id);
}

export interface NextInput { next: string; waiting_on?: WaitingOn; remind_at?: string }

export function setNext(id: string, input: NextInput, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  assertOpen(t);
  const next = String(input?.next || "").trim();
  if (!next) throw new Error("E_USAGE: track next 需要一句话 --set");
  if (input.waiting_on && !WAITING_KINDS.includes(input.waiting_on.kind)) {
    throw new Error(`E_USAGE: waiting_on.kind 只能是 ${WAITING_KINDS.join("|")}`);
  }
  appendTrack({ ts, event: "next", id, next, waiting_on: input.waiting_on, remind_at: input.remind_at });
  return getTrackOrThrow(id);
}

/** `--waiting-on human:min:等验收` → WaitingOn */
export function parseWaitingOn(raw: string): WaitingOn {
  const parts = String(raw || "").split(":");
  const kind = parts[0] as WaitingOn["kind"];
  if (!WAITING_KINDS.includes(kind) || !parts[1]) throw new Error(`E_USAGE: --waiting-on 形如 human:min 或 mr:!1975`);
  return { kind, ref: parts[1], note: parts.slice(2).join(":") || undefined };
}

export function attachTask(id: string, taskId: string, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  assertOpen(t);
  const task = String(taskId || "").trim();
  if (!task) throw new Error("E_USAGE: track attach 需要 task id");
  if (t.tasks.includes(task)) return t;
  appendTrack({ ts, event: "attach_task", id, task });
  return getTrackOrThrow(id);
}

/** 关闭 track。reason=abandoned → 状态 abandoned，其余 → done（看板口径）。 */
export function close(id: string, input: { reason: string; evidence?: string }, opts: { now?: Date } = {}): Track {
  const ts = (opts.now || new Date()).toISOString();
  const t = getTrackOrThrow(id);
  if (isTrackClosed(t)) throw new Error(`E_TRACK_CLOSED: ${id} 已关闭（${t.status}）`);
  const reason = String(input?.reason || "").trim();
  if (!reason) throw new Error("E_USAGE: track close 需要 --reason");
  appendTrack({ ts, event: "close", id, reason, evidence: input.evidence });
  return getTrackOrThrow(id);
}
