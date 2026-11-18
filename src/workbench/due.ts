// dia workbench —— 「未来关注」到期判定（M4，纯函数）
//
// 设计：docs/design/workbench.md §9.3、§5.1（活性）、§5.2（证据优先级）
// 硬约束：
//   · 纯函数：不读盘、不联网、不读墙钟（now 必须注入，判据可复现）
//   · 只看**未关闭** track（done / abandoned 不提醒）
//   · remind_at 无时区按**本地**解释（assumed_tz:"local"）；带 Z/±HH:MM 走绝对时间
//   · blocked 用 status_since，缺失时按 updated_at 兜底并标 estimated（不假装精确）

import type { Liveness, Track, TrackStatus } from "./schema.ts";

export const DUE_SCHEMA = 1 as const;

export const DEFAULT_DUE_CFG: Required<DueConfig> = {
  /** waiting_on 超过该天数即提醒（§9.3） */
  stale_wait_days: 3,
  /** blocked 超过该小时数即提醒 */
  blocked_stale_h: 24,
  /** 心跳新鲜度：suspect 的 lead 在此窗口内有心跳仍算有效 */
  heartbeat_fresh_min: 15,
};

export interface DueConfig {
  stale_wait_days?: number;
  blocked_stale_h?: number;
  heartbeat_fresh_min?: number;
}

/** track 的派生字段：status_since 由采集/折叠补；缺失时用 updated_at 兜底。 */
export type DueTrackInput = Track & { status_since?: string };

export interface DueSessionInput {
  session_id: string;
  liveness?: Liveness | null;
  last_activity?: string;
  last_heartbeat?: string | null;
  /** 持有有效 claim 数（>0 视作佐证，suspect 可路由） */
  claims?: number;
}

export interface DueBeatInput {
  session: string;
  ts: string;
}

export interface ComputeDueInput {
  tracks?: DueTrackInput[];
  sessions?: DueSessionInput[];
  beats?: DueBeatInput[];
  now: Date | string | number;
  cfg?: DueConfig;
}

export type DueReasonKind = "remind" | "stale_wait" | "no_lead" | "lead_dead" | "blocked";

export interface DueReason {
  kind: DueReasonKind;
  detail: string;
  /** 该原因已超期多久（未超期/无法算 → 0） */
  overdue_ms: number;
  since: string | null;
  /** 起点是兜底推定（如用 updated_at 代替 status_since） */
  estimated?: boolean;
}

export interface DueItem {
  track_id: string;
  title: string;
  prio: string;
  status: TrackStatus;
  next: string;
  lead: string | null;
  lead_liveness: Liveness | "none";
  remind_at: string | null;
  overdue_ms: number;
  reasons: DueReason[];
  /** 可直接复制执行的命令（不带尖括号的路径不猜值） */
  next_actions: string[];
  estimated: boolean;
}

export interface DueCounts {
  total: number;
  overdue: number;
  remind: number;
  stale_wait: number;
  no_lead: number;
  lead_dead: number;
  blocked: number;
}

export interface DueBrief {
  head: string;
  total: number;
  overdue: number;
  /** 前 5 条（与 items 同序） */
  items: DueItem[];
  next_actions: string[];
}

export interface DueResult {
  schema_v: typeof DUE_SCHEMA;
  as_of: string;
  assumed_tz: "local";
  items: DueItem[];
  counts: DueCounts;
  brief: DueBrief;
}

const CLOSED = new Set<TrackStatus>(["done", "abandoned"]);

/** 时间解析：无时区的 YYYY-MM-DD[ HH:mm[:ss]] 按**本地**解释；其余交 Date.parse。 */
export function parseLocalTime(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(s);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0),
      Number((m[7] || "0").padEnd(3, "0")),
    ).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const prioNum = (p: string | undefined): number => {
  const m = /^P(\d{1,2})$/.exec(String(p || "").toUpperCase());
  return m ? Number(m[1]) : 99;
};

function activeLead(track: DueTrackInput): string | null {
  const bound = (track.sessions || []).filter((s) => s.role === "lead" && !s.unbound_at);
  if (!bound.length) return null;
  return bound[bound.length - 1].session_id;
}

type LeadState = { lead: string | null; liveness: Liveness | "none"; dead: boolean; since: string | null; why: string };

function leadState(track: DueTrackInput, sessions: Map<string, DueSessionInput>, beats: Map<string, number>, nowMs: number, cfg: Required<DueConfig>): LeadState {
  const lead = activeLead(track);
  if (!lead) return { lead: null, liveness: "none", dead: true, since: null, why: "无活跃 lead（未 bind 或已 unbind）" };
  const rec = sessions.get(lead);
  const lastBeat = beats.get(lead) ?? null;
  const beatMs = lastBeat ?? parseLocalTime(rec?.last_heartbeat ?? null);
  const freshBeat = beatMs !== null && nowMs - beatMs <= cfg.heartbeat_fresh_min * 60_000;
  const claimed = Number(rec?.claims ?? 0) > 0;
  const lastSeen = parseLocalTime(rec?.last_activity ?? null) ?? beatMs;

  if (!rec) {
    if (freshBeat) return { lead, liveness: "suspect", dead: false, since: iso(lastSeen), why: `${cfg.heartbeat_fresh_min}min 内有心跳（无会话记录）` };
    return { lead: lead, liveness: "dead", dead: true, since: null, why: `lead ${lead} 无会话记录（可能已归档）` };
  }
  const lv = rec.liveness ?? "suspect";
  if (freshBeat) return { lead, liveness: lv, dead: false, since: iso(lastSeen), why: `${cfg.heartbeat_fresh_min}min 内有心跳` };
  if (lv === "alive") return { lead, liveness: lv, dead: false, since: iso(lastSeen), why: "宿主判定 alive" };
  if (lv === "dead") return { lead, liveness: lv, dead: true, since: iso(lastSeen), why: "宿主判定 dead（>12h 或已 suspended/archived）" };
  // suspect：无 claim 且无 15min 内心跳 → 视为失效（§5.1 route_eligible）
  if (claimed) return { lead, liveness: lv, dead: false, since: iso(lastSeen), why: "suspect 但持有 claim" };
  return { lead, liveness: lv, dead: true, since: iso(lastSeen), why: `suspect 且无 claim、${cfg.heartbeat_fresh_min}min 内无心跳` };
}

function actionsFor(item: Omit<DueItem, "next_actions">, track: DueTrackInput): string[] {
  const acts: string[] = [];
  const id = item.track_id;
  const nextOr = item.next?.trim() ? item.next.trim() : "（补一句话下一步）";
  const waiting = track.waiting_on ? `${track.waiting_on.kind}:${track.waiting_on.ref}` : "<kind:ref>";
  for (const r of item.reasons) {
    switch (r.kind) {
      case "remind":
        acts.push(`dia wb track next ${id} --set "${nextOr}" --remind-at <新的提醒时间ISO>`);
        break;
      case "no_lead":
        acts.push(`dia wb track bind ${id} --session <ses_id> --role lead`);
        break;
      case "lead_dead":
        acts.push(`dia wb track handoff ${id} --to <ses_id> --reason "lead ${item.lead_liveness}"`);
        break;
      case "stale_wait":
        acts.push(`dia wb track next ${id} --set "${nextOr}" --waiting-on ${waiting}`);
        break;
      case "blocked":
        acts.push(`dia wb track stage ${id} --status active --reason "阻塞解除"`);
        break;
    }
  }
  return [...new Set(acts)];
}

export function computeDue(input: ComputeDueInput): DueResult {
  const cfg: Required<DueConfig> = { ...DEFAULT_DUE_CFG, ...(input.cfg || {}) };
  const resolvedNow = input.now instanceof Date ? input.now.getTime() : parseLocalTime(input.now);
  if (resolvedNow === null || Number.isNaN(resolvedNow)) {
    throw new Error("E_USAGE: computeDue 需要合法的 now（Date / ISO / epoch ms）");
  }
  const nowMs = resolvedNow;
  const asOf = new Date(nowMs).toISOString();
  const sessions = new Map((input.sessions || []).map((s) => [s.session_id, s]));

  const beats = new Map<string, number>();
  for (const b of input.beats || []) {
    const t = parseLocalTime(b?.ts ?? null);
    if (t === null) continue;
    const prev = beats.get(b.session);
    if (prev === undefined || t > prev) beats.set(b.session, t);
  }

  const items: DueItem[] = [];
  for (const track of input.tracks || []) {
    if (!track || CLOSED.has(track.status)) continue;
    const reasons: DueReason[] = [];

    // 1) remind_at 到点
    const remindMs = parseLocalTime(track.remind_at ?? null);
    if (remindMs !== null && remindMs <= nowMs) {
      reasons.push({ kind: "remind", detail: `remind_at 到点（${track.remind_at}）`, overdue_ms: nowMs - remindMs, since: iso(remindMs) });
    }

    // 2) waiting_on 超期（起点用 updated_at 兜底 → estimated）
    if (track.waiting_on) {
      const baseMs = parseLocalTime(track.updated_at ?? null) ?? parseLocalTime(track.created_at ?? null);
      if (baseMs !== null) {
        const budget = cfg.stale_wait_days * 86_400_000;
        const overdue = nowMs - (baseMs + budget);
        if (overdue > 0) {
          const w = track.waiting_on;
          reasons.push({
            kind: "stale_wait",
            detail: `等 ${w.kind}:${w.ref} 已超 ${cfg.stale_wait_days} 天${w.note ? `（${w.note}）` : ""}`,
            overdue_ms: overdue,
            since: iso(baseMs),
            estimated: true,
          });
        }
      }
    }

    // 3) 无 lead / lead 失效
    const lead = leadState(track, sessions, beats, nowMs, cfg);
    if (!lead.lead) {
      reasons.push({ kind: "no_lead", detail: lead.why, overdue_ms: 0, since: null });
    } else if (lead.dead) {
      reasons.push({ kind: "lead_dead", detail: `${lead.lead}：${lead.why}`, overdue_ms: 0, since: lead.since });
    }

    // 4) blocked 超期（status_since 缺失 → updated_at 兜底并标 estimated）
    if (track.status === "blocked") {
      const statusSince = parseLocalTime(track.status_since ?? null);
      const baseMs = statusSince ?? parseLocalTime(track.updated_at ?? null);
      if (baseMs !== null) {
        const budget = cfg.blocked_stale_h * 3_600_000;
        const overdue = nowMs - (baseMs + budget);
        if (overdue > 0) {
          reasons.push({
            kind: "blocked",
            detail: `blocked 已超 ${cfg.blocked_stale_h}h`,
            overdue_ms: overdue,
            since: iso(baseMs),
            estimated: statusSince === null,
          });
        }
      }
    }

    if (!reasons.length) continue;
    const overdueMs = Math.max(0, ...reasons.map((r) => r.overdue_ms));
    const base: Omit<DueItem, "next_actions"> = {
      track_id: track.id,
      title: track.title,
      prio: track.prio,
      status: track.status,
      next: track.next || "",
      lead: lead.lead,
      lead_liveness: lead.liveness,
      remind_at: track.remind_at ?? null,
      overdue_ms: overdueMs,
      reasons,
      estimated: reasons.some((r) => r.estimated === true),
    };
    items.push({ ...base, next_actions: actionsFor(base, track) });
  }

  items.sort((a, b) => {
    if (b.overdue_ms !== a.overdue_ms) return b.overdue_ms - a.overdue_ms;
    const pa = prioNum(a.prio);
    const pb = prioNum(b.prio);
    if (pa !== pb) return pa - pb;
    const ra = parseLocalTime(a.remind_at) ?? Number.POSITIVE_INFINITY;
    const rb = parseLocalTime(b.remind_at) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.track_id.localeCompare(b.track_id);
  });

  const has = (k: DueReasonKind) => items.filter((i) => i.reasons.some((r) => r.kind === k)).length;
  const counts: DueCounts = {
    total: items.length,
    overdue: items.filter((i) => i.overdue_ms > 0).length,
    remind: has("remind"),
    stale_wait: has("stale_wait"),
    no_lead: has("no_lead"),
    lead_dead: has("lead_dead"),
    blocked: has("blocked"),
  };

  const top = items.slice(0, 5);
  const brief: DueBrief = {
    head: `你有 ${counts.total} 条 track 待关注（超期 ${counts.overdue} 条）`,
    total: counts.total,
    overdue: counts.overdue,
    items: top,
    next_actions: top.flatMap((i) => i.next_actions),
  };

  return { schema_v: DUE_SCHEMA, as_of: asOf, assumed_tz: "local", items, counts, brief };
}
