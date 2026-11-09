// 消息优先级：全派生、可解释、不落盘（快照在 send 时由调用方写入消息）
// 设计：docs/design/comm-semantics.md
// class 0=P0 最高 … 3=P3；只用于 `dia in` 的看消息顺序，不影响投递/状态。
import type { Kind } from "./collab.ts";

export interface ClassifyInput {
  /** 发送者当前 doing 任务的 eff（0=P0…3=P3+）；无任务传 2 */
  base: number;
  kind: Kind;
  requiresReply: boolean;
  hops: number;
  deadline?: string;
  now?: Date;
}

export interface ClassifyResult {
  cls: number;
  why: string[];
}

export function classify(i: ClassifyInput): ClassifyResult {
  const why: string[] = [];
  let cls = Math.max(0, Math.min(3, Math.trunc(i.base)));
  why.push(`base=${cls}`);

  if (i.requiresReply) { cls -= 1; why.push("requires_reply"); }
  if (i.kind === "handoff") { cls -= 1; why.push("handoff"); }
  if (i.kind === "notify") { cls += 1; why.push("notify"); }

  if (i.deadline) {
    const t = Date.parse(i.deadline);
    const now = (i.now ?? new Date()).getTime();
    if (!Number.isNaN(t) && t > now && t - now <= 15 * 60_000) { cls -= 1; why.push("deadline<=15m"); }
  }
  if (i.hops >= 2) { cls += 1; why.push(`hops=${i.hops}`); }

  cls = Math.max(0, Math.min(3, cls));
  // 硬上限：notify 不得高于 P2；reply 不得高于 P1；往返 ≥3 强制 P3
  if (i.kind === "notify" && cls < 2) { cls = 2; why.push("cap:notify<=P2"); }
  if (i.kind === "reply" && cls < 1) { cls = 1; why.push("cap:reply<=P1"); }
  if (i.hops >= 3) { cls = 3; why.push("cap:hops>=3"); }
  return { cls, why };
}

export const className = (cls: number) => `P${Math.max(0, Math.min(3, cls))}`;
