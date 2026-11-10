// 只读 board → 一行未读提示（无宿主依赖，便于单测）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataRoot() {
  return process.env.DIA_ROOT || process.env.DIA_DATA_DIR || join(homedir(), ".dia");
}

export function unreadLine(root = dataRoot()) {
  try {
    const b = JSON.parse(readFileSync(join(root, "collab", "state", "board.json"), "utf8"));
    if (!b || b.schema !== 1) return "";
    const at = Date.parse(b.generated_at);
    if (!Number.isFinite(at)) return "";
    const interval = Number(b.interval_s) || 300;
    const ttl = Math.min(900_000, Math.max(interval * 2000, interval * 1000 + 60_000));
    const age = Date.now() - at;
    const n = Number(b.undelivered) || 0;
    if (!n) return "";
    if (age < -5_000 || age > ttl) return `[dia-inbox] 有 ${n} 条未读（board 可能过期，先 \`dia collab observe\` 刷新）；读完用 \`dia msg ack\` 收口。`;
    return `[dia-inbox] 有 ${n} 条未读；先 \`dia msg inbox --unread\`，正文用 \`dia msg show <id>\`。`;
  } catch { return ""; }
}
