// dia-inbox（dsh 版）：每个 model step 前注入一行「未读消息」提示。
//
// 红线（与 opencode 插件一致）：只读 board.json；不调 `dia msg inbox`、不标 delivered/exposed、
// 不写盘、不联网、失败静默。真正读取由 agent 按 SKILL 执行。
// 设计：docs/design/msg-reliability-redesign.md §2
import z from "@deepseek-ai/schemastery";
import { unreadLine } from "./board.js";

export const name = "dia-inbox";
export const inject = ["systemPrompt"];
export const Config = z.object({});

export function apply(ctx) {
  try {
    ctx.systemPrompt.context({
      name: "dia-inbox:unread",
      order: ctx.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 1,
      required: false,
      interpolate: false,
      text: () => unreadLine(),
    });
  } catch { /* 宿主版本不支持 context 时静默降级为 SKILL 规则 */ }
}
