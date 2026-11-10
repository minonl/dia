// msg-events —— 消息全链路事件（append-only，一行一事件）
//
// 设计：docs/design/msg-reliability-redesign.md §2.1
// 为什么单独事件流：消息快照只保留「最终状态」，无法回答「试了几次、失败原因、为什么没收到」。
// 约束：单行 <4KB、O_APPEND、0600；失败静默（可观测性不能反过来阻断消息）。
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as paths from "./paths.ts";

export type EventName =
  | "send.accepted" | "send.failed"
  | "inject.attempted" | "inject.failed" | "inject.verified"
  | "read.observed" | "context.exposed"
  | "acked" | "replied" | "closed" | "escalated" | "deliver.uncertain";

export interface MsgEvent {
  ts: string;
  event: EventName | string;
  msg_id: string;
  thread_id?: string;
  from_state?: string;
  to_state?: string;
  actor?: string;
  transport?: string;
  attempt?: number;
  error_code?: string;
  latency_ms?: number;
  pid?: number;
}

const dir = () => join(paths.diaHome(), "collab", "events");

export function log(e: Omit<MsgEvent, "ts"> & { ts?: string }): void {
  try {
    const ts = e.ts ?? new Date().toISOString();
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    appendFileSync(join(dir(), `${ts.slice(0, 7)}.jsonl`), JSON.stringify({ ...e, ts }) + "\n", { mode: 0o600 });
  } catch { /* 事件写失败不影响消息主流程 */ }
}

export function readAll(): MsgEvent[] {
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) => readFileSync(join(dir(), f), "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as MsgEvent; } catch { return null; } })
        .filter((x): x is MsgEvent => Boolean(x)));
  } catch { return []; }
}

export function forMessage(id: string): MsgEvent[] {
  return readAll().filter((e) => e.msg_id === id);
}

export interface TraceRow { ts: string; event: string; detail?: string; delta_ms: number | null }

/** 一条消息的时间线：相邻事件间隔（ms）；首行 delta=0。 */
export function timeline(id: string): TraceRow[] {
  const rows: TraceRow[] = [];
  let prev: number | null = null;
  for (const e of forMessage(id).sort((a, b) => a.ts.localeCompare(b.ts))) {
    const t = Date.parse(e.ts);
    const detail = [
      e.transport ? `transport=${e.transport}` : "",
      e.attempt !== undefined ? `attempt=${e.attempt}` : "",
      e.error_code ? `error=${e.error_code}` : "",
      e.latency_ms !== undefined ? `latency=${e.latency_ms}ms` : "",
      e.to_state ? `state=${e.to_state}` : "",
    ].filter(Boolean).join(" ");
    rows.push({ ts: e.ts, event: e.event, detail: detail || undefined, delta_ms: prev === null ? 0 : Math.max(0, t - prev) });
    prev = t;
  }
  return rows;
}

/** 通道成功率：inject.verified / inject.attempted（与业务送达率分开统计）。 */
export function injectStats(sinceMs?: number): { attempted: number; verified: number; rate: number | null } {
  const cut = sinceMs ? Date.now() - sinceMs : 0;
  const ev = readAll().filter((e) => Date.parse(e.ts) >= cut);
  const attempted = ev.filter((e) => e.event === "inject.attempted").length;
  const verified = ev.filter((e) => e.event === "inject.verified").length;
  return { attempted, verified, rate: attempted ? Number((verified / attempted).toFixed(2)) : null };
}
