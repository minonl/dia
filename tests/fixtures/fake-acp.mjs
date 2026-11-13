#!/usr/bin/env node
// fake-acp.mjs —— 最小 ACP 服务器（用于 team run --acp/--dsh 的确定性测试）
// 以 `opencode acp` 或 `dsh --profile dabo-<role>` 的身份启动，按角色返回固定 JSON。
// 环境变量：FAKE_VERIFY=通过|不通过|无法判定（默认 通过）
//           FAKE_REDTEAM_HIGH=1|always（1 = 第一轮 high、复检轮清零；always = 始终 high）
//           FAKE_JUDGE=<plan.judge 默认值>
//           FAKE_BUILDER_FIX=<文件名>（builder 收到「Fix these high-severity findings」时在 cwd 里写该文件，
//                              用于验证修复后的真实改动被写回 diff.patch）
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const log = (o) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n"); };
let role = null;
const pi = process.argv.indexOf("--profile");
if (pi >= 0) role = String(process.argv[pi + 1] || "").replace(/^dabo-/, "") || null;

const sessions = new Map(); // sid -> { role, cwd }
let seq = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// dsh 每次 prompt 都是独立进程，所以「第一轮/复检轮」用快照目录名判断而不是进程内计数器。
function redteamHigh(cwd, prompt) {
  const mode = process.env.FAKE_REDTEAM_HIGH;
  if (!mode) return false;
  if (mode === "always") return true;
  return !String(prompt || "").includes("Round: 2");
}

function textFor(r, cwd, prompt) {
  switch (r) {
    case "planner":
      return JSON.stringify({ judge: process.env.FAKE_JUDGE || "test -f a.txt", steps: ["impl", "verify"] });
    case "builder":
      return "changed: a.txt";
    case "verifier":
      return JSON.stringify({ conclusion: process.env.FAKE_VERIFY || "通过", evidence: ["fake-verify: ok"] });
    case "redteam":
      return JSON.stringify({ findings: redteamHigh(cwd, prompt) ? [{ severity: "high", trigger: "fake", consequence: "fake", repro: "fake" }] : [] });
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
      sessions.set(sid, { role, cwd: params?.cwd || null });
      log({ ev: "new", sid, cwd: params?.cwd || null, role });
      send({ jsonrpc: "2.0", id, result: { sessionId: sid } });
      continue;
    }
    if (method === "session/set_mode") {
      const mode = String(params?.modeId || "").replace(/^dabo-/, "");
      const cur = sessions.get(params?.sessionId) || { cwd: null };
      sessions.set(params?.sessionId, { role: mode, cwd: cur.cwd });
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
      const s = sessions.get(sid) || { role, cwd: null };
      const effRole = s.role || role || "builder";
      const promptText = String(params?.prompt?.map?.((p) => p?.text || "").join("\n") || "");
      log({ ev: "prompt", sid, role: effRole, text: promptText });
      // 模拟 builder-fix 真的改工作区（默认关闭，不影响其它用例）
      const fixName = process.env.FAKE_BUILDER_FIX;
      if (fixName && effRole === "builder" && promptText.includes("Fix these high-severity findings")) {
        try { appendFileSync(join(s.cwd, fixName), "fix\n"); } catch {}
      }
      const text = textFor(effRole, s.cwd, promptText);
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
