#!/usr/bin/env node
// fake-acp.mjs —— 最小 ACP 服务器（用于 team run --acp/--dsh 的确定性测试）
// 以 `opencode acp` 或 `dsh --profile dabo-<role>` 的身份启动，按角色返回固定 JSON。
// 环境变量：FAKE_VERIFY=通过|不通过|无法判定（默认 通过）
import { appendFileSync } from "node:fs";
const log = (o) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n"); };
let role = null;
const pi = process.argv.indexOf("--profile");
if (pi >= 0) role = String(process.argv[pi + 1] || "").replace(/^dabo-/, "") || null;

const sessions = new Map();
let seq = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function textFor(r) {
  switch (r) {
    case "planner":
      return JSON.stringify({ judge: "fake judge: a.txt 存在", steps: ["impl", "verify"] });
    case "builder":
      return "changed: a.txt";
    case "verifier":
      return JSON.stringify({ conclusion: process.env.FAKE_VERIFY || "通过", evidence: ["fake-verify: ok"] });
    case "redteam":
      return JSON.stringify({ findings: [] });
    default:
      return "ok";
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const { id, method, params } = d;
    if (method === "initialize") { send({ jsonrpc: "2.0", id, result: {} }); continue; }
    if (method === "session/new") {
      const sid = "s" + (++seq);
      sessions.set(sid, role);
      log({ ev: "new", sid, cwd: params?.cwd || null, role });
      send({ jsonrpc: "2.0", id, result: { sessionId: sid } });
      continue;
    }
    if (method === "session/set_mode") {
      const mode = String(params?.modeId || "").replace(/^dabo-/, "");
      sessions.set(params?.sessionId, mode);
      log({ ev: "mode", sid: params?.sessionId, mode });
      send({ jsonrpc: "2.0", id, result: {} });
      continue;
    }
    if (method === "session/set_config_option") {
      log({ ev: "config", sid: params?.sessionId, id: params?.configId, value: params?.value });
      send({ jsonrpc: "2.0", id, result: {} });
      continue;
    }
    if (method === "session/prompt") {
      const sid = params?.sessionId;
      const r = sessions.get(sid) || role || "builder";
      const text = textFor(r);
      send({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
      });
      send({ jsonrpc: "2.0", id, result: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
      continue;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method: " + method } });
  }
});
process.stdin.on("end", () => process.exit(0));
