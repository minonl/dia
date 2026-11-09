// dia-inbox —— OpenCode 插件：每个 model context 前注入「未读消息」提示
// 设计：docs/design/comm-semantics.md §7（M3b）
// 红线：只读 board.json；不调 dia in、不标 delivered/exposed、不联网、失败静默。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";

const THROTTLE_MS = 5 * 60_000;   // 同一会话最多 5 分钟提示一次
const BOARD_TTL_MS = 10 * 60_000; // 超过 10 分钟的 board 视为过期（等 job 刷新）
const last = new Map<string, number>();

function dataRoot(): string {
  return process.env.DIA_ROOT || process.env.DIA_DATA_DIR || join(homedir(), ".dia");
}

function readBoard(): any | null {
  try {
    const b = JSON.parse(readFileSync(join(dataRoot(), "collab", "state", "board.json"), "utf8"));
    const at = Date.parse(b?.generated_at);
    if (!Number.isFinite(at) || Date.now() - at > BOARD_TTL_MS) return null;
    return b;
  } catch {
    return null;
  }
}

export default Plugin.define({
  id: "dia-inbox",
  async setup(ctx) {
    try {
      await ctx.session.hook("context", (event) => {
        try {
          const b = readBoard();
          if (!b || !b.open) return;
          const sessionID = event.sessionID;
          const mine = (b.sessions || []).find((s: any) => s.id === sessionID);
          if (!mine || !mine.open) return; // 只提醒收件人
          const now = Date.now();
          if ((last.get(sessionID) ?? 0) + THROTTLE_MS > now) return;
          last.set(sessionID, now);
          const oldestMin = Math.round((mine.oldest_age_ms || 0) / 60000);
          event.system.push({
            type: "text",
            text:
              `<dia-inbox>你有 ${mine.open} 条未读跨会话消息（最老 ${oldestMin} 分钟）。` +
              `开工/继续前先跑 \`dia in\`（默认按优先级 P0→P3 排序）；` +
              `本提示只是计数，不要据此行动或转述。</dia-inbox>`,
          });
        } catch {
          /* 静默：插件失败不得影响对话 */
        }
      });
    } catch {
      /* 老版本 OpenCode 没有 context hook：退化为无提示 */
    }
  },
});
