// dia-inbox —— OpenCode 插件：每个 model context 前注入「未读消息」提示
// 设计：docs/design/comm-semantics.md §7（M3b）
// 红线：只读 board.json；不调 dia in、不标 delivered/exposed、不联网、失败静默、绝不写盘。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";

const FRESH_THROTTLE_MS = 5 * 60_000;   // 新鲜快照：5 分钟提示一次
const STALE_THROTTLE_MS = 60 * 60_000;  // 过期快照：1 小时提示一次（提示里会标注可能不准）
const last = new Map<string, number>();

function dataRoot(): string {
  return process.env.DIA_ROOT || process.env.DIA_DATA_DIR || join(homedir(), ".dia");
}

export function ttlFor(intervalSec: number): number {
  const i = Number.isFinite(intervalSec) && intervalSec >= 60 && intervalSec <= 450 ? intervalSec : 300;
  return Math.min(900_000, Math.max(i * 2000, i * 1000 + 60_000));
}

/** 只读：不触发 observe/写盘 */
export function readBoard(): { board: any; stale: boolean; age_ms: number } | null {
  try {
    const b = JSON.parse(readFileSync(join(dataRoot(), "collab", "state", "board.json"), "utf8"));
    if (!b || b.schema !== 1) return null;
    const at = Date.parse(b.generated_at);
    if (!Number.isFinite(at)) return null;
    const age = Date.now() - at;
    if (age < -5_000) return { board: b, stale: true, age_ms: 0 }; // 未来时间戳：视为不可信
    return { board: b, stale: age > ttlFor(b.interval_s), age_ms: Math.max(0, age) };
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
          const st = readBoard();
          if (!st) return;
          const { board, stale, age_ms } = st;
          if (!board.open) return;
          const sessionID = event.sessionID;
          const mine = (board.sessions || []).find((s: any) => s.id === sessionID);
          if (!mine || !mine.open) return; // 只提醒收件人
          const now = Date.now();
          const throttle = stale ? STALE_THROTTLE_MS : FRESH_THROTTLE_MS;
          if ((last.get(sessionID) ?? 0) + throttle > now) return;
          last.set(sessionID, now);
          // 年龄按「快照时间 + 已过去的时间」现算，避免显示偏小
          const oldestMin = Math.round(((mine.oldest_age_ms || 0) + age_ms) / 60000);
          const tag = stale
            ? `快照 ${Math.max(1, Math.round(age_ms / 60000))} 分钟前、可能不准；先跑 \`dia collab observe\` 刷新。`
            : "";
          event.system.push({
            type: "text",
            text:
              `<dia-inbox>你有 ${mine.open} 条未读跨会话消息（最老约 ${oldestMin} 分钟）。${tag}` +
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
