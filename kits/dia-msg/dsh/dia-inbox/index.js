// dia-inbox（dsh 版）：每个 model step 前注入一行「未读消息」提示。
//
// 红线（与 opencode 插件一致）：只读 board.json；不调 `dia msg inbox`、不标 delivered/exposed、
// 不写盘、不联网、失败静默。真正读取由 agent 按 SKILL 执行。
// 设计：docs/design/msg-reliability-redesign.md §2
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "dia-inbox";
export const inject = ["systemPrompt"];
export const Config = z.object({});

function dataRoot() {
  return process.env.DIA_ROOT || process.env.DIA_DATA_DIR || join(homedir(), ".dia");
}

function readBoard() {
  try {
    const b = JSON.parse(readFileSync(join(dataRoot(), "collab", "state", "board.json"), "utf8"));
    if (!b || b.schema !== 1) return null;
    const at = Date.parse(b.generated_at);
    if (!Number.isFinite(at)) return null;
    const interval = Number(b.interval_s) || 300;
    const ttl = Math.min(900_000, Math.max(interval * 2000, interval * 1000 + 60_000));
    const age = Date.now() - at;
    if (age < -5_000) return { board: b, stale: true };
    return { board: b, stale: age > ttl };
  } catch { return null; }
}

export function apply(ctx) {
  try {
    ctx.systemPrompt.context({
      name: "dia-inbox:unread",
      order: ctx.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 1,
      required: false,
      interpolate: false,
      text: () => {
        const st = readBoard();
        if (!st) return "";
        const n = Number(st.board.undelivered) || 0;
        if (!n) return "";
        return st.stale
          ? `[dia-inbox] 有 ${n} 条未读（board 可能过期，先 \`dia collab observe\` 刷新）；读完用 \`dia msg ack\` 收口。`
          : `[dia-inbox] 有 ${n} 条未读；先 \`dia msg inbox --unread\`，正文用 \`dia msg show <id>\`。`;
      },
    });
  } catch { /* 宿主版本不支持 context 时静默降级为 SKILL 规则 */ }
}
