// dia seats —— 固定席位 + 上下文亲和（M2）
// 设计：docs/design/seat-scheduling-m2.md
// 只读建议：不写账本、不抢占、不常驻；claim 仍是唯一并发信号。
import type { Task } from "./task.ts";
import * as plan from "./plan.ts";
import * as collab from "./collab.ts";
import * as claims from "./claims.ts";

export interface SeatsOptions {
  seats: number;
  now?: Date;
  presenceTtlMs?: number;
  /** 最近任务取样条数（touches 亲和） */
  history?: number;
}

export type SeatState = "idle" | "busy" | "holding" | "offline";

export interface SeatInfo {
  seat: string;
  state: SeatState;
  presence_at: string;
  focus: string | null;
}

export interface Affinity {
  owner: 0 | 1;
  split: 0 | 1;
  jaccard: number;
  module: 0 | 1;
  total: number;
}

export interface Assignment {
  seat: string;
  task: string;
  rank: number;
  eff: string;
  cost: number;
  affinity: Affinity;
  why: string;
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

const moduleOf = (p: string) => p.split("/").slice(0, 2).join("/");

export function assignSeats(tasks: Task[], opts: SeatsOptions) {
  const now = opts.now ?? new Date();
  const ttl = opts.presenceTtlMs ?? 30 * 60_000;
  const want = Math.max(0, Math.trunc(opts.seats));
  const historyN = opts.history ?? 5;
  const nowMs = now.getTime();

  const sessions = collab.listSessions();
  const online = sessions
    .filter((s) => {
      const t = Date.parse(s.last_seen);
      return Number.isFinite(t) && nowMs - t <= ttl && t <= nowMs + 60_000;
    })
    .sort((a, b) => (Date.parse(b.last_seen) - Date.parse(a.last_seen)) || a.session_id.localeCompare(b.session_id));
  const chosen = online.slice(0, want);

  const derived = plan.derive(tasks).byId;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const activeClaims = claims.list({ now });

  const seatTasks = (id: string) => tasks.filter((t) => t.owner === id && ["doing", "review", "done", "accepted", "blocked"].includes(t.status))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, historyN);

  const seats: SeatInfo[] = chosen.map((s) => {
    const mine = tasks.filter((t) => t.owner === s.session_id && !plan.isTerminal(t));
    const busy = mine.filter((t) => t.status === "doing");
    const holding = mine.filter((t) => t.status === "blocked" || t.status === "review");
    const state: SeatState = busy.length ? "busy" : holding.length ? "holding" : "idle";
    return {
      seat: s.session_id,
      state,
      presence_at: s.last_seen,
      focus: (busy[0] || holding[0])?.id ?? null,
    };
  });

  const slots = new Map<string, number>();
  for (const s of seats) slots.set(s.seat, s.state === "busy" ? 0 : 1);

  const affinityOf = (seat: string, t: Task): Affinity => {
    const recent = seatTasks(seat);
    const owner: 0 | 1 = t.owner === seat ? 1 : 0;
    const split: 0 | 1 = t.split_from && recent.some((r) => r.id === t.split_from || r.split_from === t.split_from) ? 1 : 0;
    const mineTouches = new Set(recent.flatMap((r) => r.touches));
    const jac = Math.round(jaccard(new Set(t.touches), mineTouches) * 1000) / 1000;
    const modules = new Set([...mineTouches].map(moduleOf));
    const module: 0 | 1 = t.touches.some((p) => modules.has(moduleOf(p))) ? 1 : 0;
    const total = 3 * owner + 2 * split + 2 * jac + module;
    return { owner, split, jaccard: jac, module, total: Math.round(total * 1000) / 1000 };
  };

  const candidates = tasks
    .filter((t) => derived.get(t.id)?.startable && derived.get(t.id)?.rank !== null)
    .sort((a, b) => derived.get(a.id)!.rank! - derived.get(b.id)!.rank!);

  const assignments: Assignment[] = [];
  const used = new Set<string>();
  for (const t of candidates) {
    let best: { seat: string; cost: number; aff: Affinity } | null = null;
    for (const s of seats) {
      if ((slots.get(s.seat) ?? 0) <= 0) continue;
      const aff = affinityOf(s.seat, t);
      const cost = Math.round((1 - aff.total / 8) * 1000) / 1000;
      if (!best || cost < best.cost || (cost === best.cost && s.seat < best.seat)) best = { seat: s.seat, cost, aff };
    }
    if (!best) continue;
    slots.set(best.seat, (slots.get(best.seat) ?? 0) - 1);
    used.add(t.id);
    const bits = [`eff=${derived.get(t.id)!.eff_prio}`];
    if (best.aff.owner) bits.push("同 owner");
    if (best.aff.split) bits.push("同 split 组");
    if (best.aff.jaccard) bits.push(`路径重叠 ${best.aff.jaccard}`);
    if (best.aff.module) bits.push("同模块");
    assignments.push({
      seat: best.seat, task: t.id, rank: derived.get(t.id)!.rank!,
      eff: derived.get(t.id)!.eff_prio, cost: best.cost, affinity: best.aff,
      why: bits.join(" · "),
    });
  }

  const unassigned = candidates.filter((t) => !used.has(t.id)).map((t) => ({
    task: t.id, rank: derived.get(t.id)!.rank!, reason: seats.length ? "no_seat" : "seat_offline",
  }));

  const seatIds = new Set(seats.map((s) => s.seat));
  const conflicts: { task: string; kind: string; detail: string }[] = [];
  for (const t of candidates) {
    for (const c of activeClaims) {
      if (!t.touches.includes(c.path)) continue;
      if (!seatIds.has(c.holder)) conflicts.push({ task: t.id, kind: "claim_held_offline", detail: `${c.path} 由 ${c.holder} 持有` });
      else {
        const a = assignments.find((x) => x.task === t.id);
        if (a && a.seat !== c.holder) conflicts.push({ task: t.id, kind: "claim_overlap", detail: `${c.path} 由 ${c.holder} 持有` });
      }
    }
  }

  const idle = seats.filter((s) => (slots.get(s.seat) ?? 0) > 0).length;
  return {
    schema: 1 as const,
    policy: "seats-v1" as const,
    seats,
    assignments,
    unassigned,
    conflicts,
    metrics: { assignments: assignments.length, idle_slots: idle, online: online.length, requested: want },
  };
}
