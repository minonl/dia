// tests/service-agent.test.ts — agent 型服务（docs/service-noun.md §14）
// 覆盖：入口互斥 / acp 健康检查清单规则 / acpAgentCommand 映射 / runAcpHealth 三态（fake ACP）
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "../src/service.ts";

const agentManifest = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "service",
  id: "example-agent",
  version: "0.1.0",
  entry: { agent: { host: "dsh", profile: "dia-acp" } },
  lifecycle: { type: "service" },
  healthcheck: { kind: "acp", interval: 1800, timeout: 5 },
  ...over,
});

describe("§14.2 入口互斥（entry.cmd vs entry.agent）", () => {
  test("agent 型最小清单通过", () => {
    expect(s.validateServiceManifest(agentManifest()).entry.agent?.host).toBe("dsh");
  });

  test("同时声明 cmd 与 agent → E_MANIFEST", () => {
    expect(() => s.validateServiceManifest(agentManifest({ entry: { cmd: "bin/x", agent: { host: "dsh" } } })))
      .toThrow(/互斥/);
  });

  test("两者都没有 → E_MANIFEST", () => {
    expect(() => s.validateServiceManifest(agentManifest({ entry: {} }))).toThrow(/E_MANIFEST/);
  });

  test("host 非法 / profile 空串 / opencode 带 profile → E_MANIFEST", () => {
    expect(() => s.validateServiceManifest(agentManifest({ entry: { agent: { host: "claude" } } }))).toThrow(/host/);
    expect(() => s.validateServiceManifest(agentManifest({ entry: { agent: { host: "dsh", profile: "  " } } }))).toThrow(/profile/);
    expect(() => s.validateServiceManifest(agentManifest({ entry: { agent: { host: "opencode", profile: "x" } } }))).toThrow(/profile/);
  });
});

describe("§14.3 healthcheck.kind=acp 的清单规则", () => {
  test("agent 型必须配 kind=acp", () => {
    expect(() => s.validateServiceManifest(agentManifest({ healthcheck: { interval: 60 } }))).toThrow(/kind="acp"/);
  });

  test("kind=acp 不得再声明 cmd", () => {
    expect(() => s.validateServiceManifest(agentManifest({ healthcheck: { kind: "acp", cmd: "bin/h" } }))).toThrow(/不得再声明 cmd/);
  });

  test("脚本型 entry 不能配 kind=acp", () => {
    expect(() => s.validateServiceManifest(agentManifest({
      entry: { cmd: "bin/x" }, healthcheck: { kind: "acp", interval: 60 },
    }))).toThrow(/只适用于 entry.agent/);
  });

  test("缺省 kind = script（向后兼容）", () => {
    const m = agentManifest({ entry: { cmd: "bin/x" }, healthcheck: { cmd: "bin/h", interval: 60 } });
    expect(s.validateServiceManifest(m).healthcheck?.cmd).toBe("bin/h");
    expect(s.healthcheckKind({ cmd: "bin/h" })).toBe("script");
  });
});

describe("§14.2 acpAgentCommand 映射", () => {
  test("dsh / dsh+profile / opencode", () => {
    expect(s.acpAgentCommand({ host: "dsh" })).toEqual(["dsh", "acp"]);
    expect(s.acpAgentCommand({ host: "dsh", profile: "dia-acp" })).toEqual(["dsh", "--profile", "dia-acp", "acp"]);
    expect(s.acpAgentCommand({ host: "opencode" })).toEqual(["opencode", "acp"]);
  });
});

// ── runAcpHealth：用 fake ACP 端点跑三态 ──────────────────────────────────────

const FAKE = `#!/usr/bin/env node
// 最小 ACP 端点：按行读 JSON-RPC，按 FAKE_ACP_MODE 决定行为
const mode = process.env.FAKE_ACP_MODE || "ok";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      if (mode === "init-error") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "boom" } }) + "\\n"); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }) + "\\n");
    } else if (m.method === "session/new") {
      if (mode === "session-error") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "auth" } }) + "\\n"); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-1" } }) + "\\n");
    }
  }
});
`;

let root: string;
let bin: string;
let fakeDsh: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "svc-agent-"));
  bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  fakeDsh = join(bin, "dsh");
  // 用 shell 包一层：shebang 的 node 由 PATH 解析，测试里把原 PATH 带上
  writeFileSync(fakeDsh, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "fake-acp.mjs")}" "$@"\n`);
  writeFileSync(join(root, "fake-acp.mjs"), FAKE);
  chmodSync(fakeDsh, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (mode: string | null) =>
  s.runAcpHealth(s.validateServiceManifest(agentManifest()) as any, {
    dir: root,
    env: { PATH: mode === null ? "/nonexistent" : `${bin}:${process.env.PATH}`, ...(mode ? { FAKE_ACP_MODE: mode } : {}) },
  });

describe("§14.3 runAcpHealth 三态（fake ACP）", () => {
  test("initialize + session/new 都成功 → ok", async () => {
    const r = await run("ok");
    expect(r.judgement.state).toBe("ok");
    expect(r.judgement.exit).toBe(0);
    expect(r.steps.map((x) => `${x.step}:${x.state}`)).toEqual(["initialize:ok", "session/new:ok"]);
  });

  test("initialize 报错 → degraded（infra/配置面，不是 fail）", async () => {
    const r = await run("init-error");
    expect(r.judgement.state).toBe("degraded");
    expect(r.judgement.exit).toBe(20);
  });

  test("session/new 报错 → fail（鉴权/配置，不是抖动）", async () => {
    const r = await run("session-error");
    expect(r.judgement.state).toBe("fail");
    expect(r.judgement.exit).toBe(21);
  });

  test("端点起不来（不在 PATH）→ degraded，且不抛", async () => {
    const r = await run(null);
    expect(r.judgement.state).toBe("degraded");
    expect(r.steps[0].detail).toMatch(/端点起不来/);
  });
});
