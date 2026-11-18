// trace —— 消息留痕的**唯一入口**（业务代码只表达「发生了什么」）
//
// 分工（与 src/log.ts 配套，别改错地方）：
//   · 写进事件流（msg-events.ts，JSONL）：状态迁移的**事实**。`dia msg trace` / stats 都靠它，
//     格式不能变（trace 依赖 to_state/from_state/latency_ms/attempt/error_code 这些字段）。
//   · 写进运行日志（log.ts，stderr）：**细节与业务快照**（try 了几次、为什么 mailbox-only、
//     正文大小、优先级依据……），按 verbose/debug/info 分级，供人复盘。
// 同一个留痕点在两处各写一次是可以的：结构化那半给机器，冗余那半给人。
//
// 硬约束：
//   · 所有函数返回 void，**不抛异常**（事件流/日志写失败都不影响消息主流程）；
//   · 不改变业务分支 —— 调用方不能靠这里返回值做判断，也不许 await。
import * as events from "./msg-events.ts";
import { logger, type Level } from "./log.ts";

const alog = logger("msg");

/** 状态迁移 / 投递尝试的事实条目（写进事件流，顺带一条人可读镜像）。 */
export interface TraceFact extends Omit<events.MsgEvent, "ts"> {
  /** 人可读补充（不进事件流）：为什么、带了什么上下文 */
  note?: string;
}

/** 分级：哪些事件在什么级别下额外打一行人可读日志。 */
const MIRROR: Record<string, Level> = {
  "send.accepted": "info",
  "send.failed": "warn",
  "inject.attempted": "debug",
  "inject.verified": "debug",
  "inject.failed": "info",
  "read.observed": "debug",
  "context.exposed": "debug",
  acked: "info",
  replied: "info",
  closed: "info",
  escalated: "info",
  "deliver.uncertain": "info",
};

/**
 * 记一条留痕事实：事件流必写（trace 的数据源），日志按级别镜像。
 * 永不抛异常、永不同步阻塞在 IO 之外。
 */
export function fact(e: TraceFact): void {
  const { note, ...event } = e;
  // 1) 结构化事件流：格式与历史一致（msg-events 自己吞掉写失败）
  try {
    events.log(event);
  } catch { /* events.log 已静默；双保险 */ }
  // 2) 人可读镜像：级别按事件名，note/from_state/to_state 快照都带上
  try {
    const lv = MIRROR[event.event] ?? "verbose";
    alog[lv](`event=${event.event}`, {
      msg: event.msg_id,
      thread: event.thread_id,
      actor: event.actor,
      from: event.from_state,
      to: event.to_state,
      transport: event.transport,
      attempt: event.attempt,
      error: event.error_code,
      latency_ms: event.latency_ms,
      note,
    });
  } catch { /* 日志失败不影响业务 */ }
}

/** 纯日志（不进事件流）：细节快照、分支原因、大小、优先级依据等。 */
export interface DetailFields { [k: string]: unknown }

export function detail(message: string, f?: DetailFields): void { alog.verbose(message, f); }
export function detailDebug(message: string, f?: DetailFields): void { alog.debug(message, f); }
export function detailInfo(message: string, f?: DetailFields): void { alog.info(message, f); }
export function detailWarn(message: string, f?: DetailFields): void { alog.warn(message, f); }
export function detailError(message: string, f?: DetailFields): void { alog.error(message, f); }

/** 业务状态快照：显式命名，便于 grep（verbose 级，可整体关掉）。 */
export function snapshot(where: string, state: Record<string, unknown>): void {
  alog.verbose(`snapshot:${where}`, state);
}
