#!/usr/bin/env node
// mock-acp-session.mjs —— 最小「已有会话」ACP 服务器（opencode v2 的 session/load 通道）
//
// ⚠️ 这只测**协议层**（JSON-RPC 形状 + 状态机），**测不到真 opencode 的行为**。
//    真 opencode 2.2.6（WSL2）实测口径见 docs/design/msg-reliability-redesign.md：
//    initialize → session/load → session/prompt 必须同一进程，否则 -32602 session not found。
//
// 模拟的关键约束：
//   · 只有被 `session/load` 加载进**本进程**的 session 才能 prompt；否则回 -32602。
//     （所以「load 在 A 进程、prompt 在 B 进程」的回归用例是两个实例各自隔离。）
//   · 不提供 session/new：老路径若误用会得到 -32601。
//   · session/prompt 的正文原样记进 transcript（`params`），测试靠它断言「指针 prompt 里的标题对不对」。
//
// 环境变量：
//   MOCK_ACP_EXPECT_SESSION=<ses_…>  session/load 只接受这个 id，其余 -32602
//   MOCK_ACP_TRANSCRIPT=<file>       把收到的每个 method 追加一行 JSON（调试/断言用）
import { appendFileSync } from "node:fs";

const log = (o) => { if (process.env.MOCK_ACP_TRANSCRIPT) appendFileSync(process.env.MOCK_ACP_TRANSCRIPT, JSON.stringify(o) + "\n"); };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

/** 本进程内「已加载」的会话（模拟 opencode 的进程内 session 表） */
const loaded = new Set();
const expectSession = process.env.MOCK_ACP_EXPECT_SESSION || null;

function handle(m) {
  const { id, method, params } = m;
  log({ method, params });
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (method === "session/new") {
    // 故意不支持：这条通道的正确做法是 load 已有会话，不是开新的
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "mock: session/new not supported on this transport" } });
  }
  if (method === "session/load") {
    const sid = params?.sessionId;
    const ok = sid && (!expectSession || sid === expectSession);
    if (!ok) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "session not found: " + sid } });
    loaded.add(sid);
    return send({ jsonrpc: "2.0", id, result: {} });
  }
  if (method === "session/prompt") {
    const sid = params?.sessionId;
    if (!sid || !loaded.has(sid)) {
      // 关键护栏：没在本进程 load 过 → session not found（跨进程拆分的真实表现）
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "session not found: " + sid } });
    }
    send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp-session-ok" } } },
    });
    return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } } });
  }
  return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method: " + method } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
process.stdin.on("end", () => process.exit(0));
