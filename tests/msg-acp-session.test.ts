// dia msg × ACP(opencode v2 session/load) —— 协议层测试
//
// ⚠️ 本文件只测 **协议层**：mock 服务器（tests/fixtures/mock-acp-session.mjs）模拟
//    initialize / session/load / session/prompt 的 JSON-RPC 形状与「session 必须在本进程 load 过」的约束。
//    **测不到真 opencode 2.2.6 的行为**（真机实测记录见 docs/design/msg-reliability-redesign.md §4）。
//
// 覆盖：
//   1) 正向：host=opencode + acp_cmd → send 立即返回 notified=acp(queued)，后台 inject.verified(transport=acp)
//   2) 反向：sessionId 不匹配 → inject.failed(E_ACP_NO_SESSION)，消息仍 pending
//   3) 护栏：load 在 A 进程、prompt 在 B 进程必须失败（防将来把 load/prompt 拆开）
//   4) 静默消除：无 tmux 无 acp_cmd → inject.failed(E_NO_CHANNEL)
import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const mockSession = join(import.meta.dir, "fixtures", "mock-acp-session.mjs");

let root: string, transcript: string;
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, MOCK_ACP_TRANSCRIPT: transcript, ...env } as Record<string, string>,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-acpsess-"));
  transcript = join(root, "acp-transcript.jsonl");
});

/** 写一条会话记录（whoami 的落盘形状）；pane 故意不给 = 本机无 tmux 的常态 */
function session(id: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, "collab", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    schema: 1, session_id: id, host: "opencode", display_name: id, cwd: "/tmp",
    started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    capabilities: ["msg:v2"], address: `session:${id}`,
    ...extra,
  }));
}

function events(): any[] {
  const dir = join(root, "collab", "events");
  if (!existsSync(dir)) return [];
  return readFileSync(join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function waitFor(pred: () => boolean, ms = 8000): boolean {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return pred();
}

const acpCmd = () => `node ${mockSession}`;

describe("dia msg × ACP session/load（opencode v2）", () => {
  test("正向：host=opencode + acp_cmd → 立即 queued，后台 verified(transport=acp)", () => {
    session("ses_acp_ok", { acp_cmd: acpCmd() });
    const t0 = Date.now();
    const r = run(["msg", "send", "--to", "ses_acp_ok", "--session", "ses_sender", "--subject", "s"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notified=acp(queued)");
    // 异步：send 不等 ACP 一轮
    expect(Date.now() - t0).toBeLessThan(5000);

    const ok = waitFor(() => events().some((e) => e.event === "inject.verified" && e.transport === "acp"));
    if (!ok) console.error("EVENTS:", JSON.stringify(events(), null, 1));
    expect(ok).toBe(true);
    expect(events().some((e) => e.event === "inject.attempted" && e.transport === "acp")).toBe(true);

    // 协议顺序：initialize → session/load → session/prompt，且全程没有 session/new
    const methods = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).method);
    expect(methods).toEqual(["initialize", "session/load", "session/prompt"]);
  });

  test("反向：session 不存在（-32602）→ inject.failed(E_ACP_NO_SESSION)，消息仍 pending", () => {
    // mock 只认 ses_expected，收件箱却是 ses_acp_bad → load 必然 -32602
    session("ses_acp_bad", { acp_cmd: `${acpCmd()}`, cwd: "/tmp" });
    const r = run(["msg", "send", "--to", "ses_acp_bad", "--session", "ses_sender", "--subject", "s"],
      { MOCK_ACP_EXPECT_SESSION: "ses_expected" });
    expect(r.stdout).toContain("notified=acp(queued)");

    const failed = waitFor(() => events().some((e) => e.event === "inject.failed" && e.transport === "acp"));
    if (!failed) console.error("EVENTS:", JSON.stringify(events(), null, 1));
    expect(failed).toBe(true);
    const ev = events().find((e) => e.event === "inject.failed" && e.transport === "acp");
    expect(ev.error_code).toBe("E_ACP_NO_SESSION");
    expect(events().some((e) => e.event === "inject.verified" && e.transport === "acp")).toBe(false);

    const id = r.stdout.split("\t")[0];
    const shown = JSON.parse(run(["show", id, "--json"]).stdout);
    expect(shown.state).toBe("pending");
    expect(shown.injected_at).toBeUndefined();
  });

  test("护栏：load 在 A 进程、prompt 在 B 进程必须失败（session not found）", async () => {
    // 两个独立 mock 实例 = 两个独立 ACP 进程（真实场景是两次 `opencode acp`）
    const { AcpClient } = await import("../src/acp.ts");
    const argv = ["node", mockSession];
    const sid = "ses_split";
    const a = new AcpClient(argv, "/tmp", 10_000);
    const b = new AcpClient(argv, "/tmp", 10_000);
    try {
      await a.init();
      await a.loadSession(sid, "/tmp");     // 只在 A 进程里加载
      await b.init();
      // B 进程没 load 过这个 session → 必须报错，而不是「看起来成功」
      let err: any = null;
      try { await b.prompt(sid, "hi"); } catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(String(err.message)).toContain("-32602");
      expect(String(err.message)).toContain("session not found");
      // 对照组：同一进程（A）里 load 后 prompt 是通的
      const okr = await a.prompt(sid, "hi");
      expect(okr.text).toContain("acp-session-ok");
    } finally {
      a.close(); b.close();
    }
  });

  test("静默消除：无 tmux 无 acp_cmd → inject.failed(E_NO_CHANNEL)，输出 mailbox-only", () => {
    session("ses_plain");  // host=opencode 但没有 acp_cmd，也没有 pane
    const r = run(["msg", "send", "--to", "ses_plain", "--session", "ses_sender", "--subject", "s"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notified=mailbox-only(E_NO_CHANNEL)");
    const fail = events().find((e) => e.event === "inject.failed");
    expect(fail).toBeTruthy();
    expect(fail.error_code).toBe("E_NO_CHANNEL");
    expect(events().some((e) => e.event === "inject.attempted")).toBe(false);
  });

  test("whoami 读 DIA_ACP_CMD 进会话记录；未设置则不写字段", () => {
    const withCmd = run(["whoami", "--session", "ses_w1", "--json"], { DIA_ACP_CMD: "opencode acp", TMUX_PANE: "" });
    expect(withCmd.status).toBe(0);
    const rec1 = JSON.parse(readFileSync(join(root, "collab", "sessions", "ses_w1.json"), "utf8"));
    expect(rec1.acp_cmd).toBe("opencode acp");

    const noCmd = run(["whoami", "--session", "ses_w2", "--json"], { DIA_ACP_CMD: "", TMUX_PANE: "" });
    expect(noCmd.status).toBe(0);
    const rec2 = JSON.parse(readFileSync(join(root, "collab", "sessions", "ses_w2.json"), "utf8"));
    expect(rec2.acp_cmd).toBeUndefined();
  });

  test("非 opencode host 即使有 acp_cmd 也不走 ACP（本轮只打通 opencode v2）", () => {
    session("ses_dsh", { host: "dsh", acp_cmd: acpCmd() });
    const r = run(["msg", "send", "--to", "ses_dsh", "--session", "ses_sender", "--subject", "s"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notified=mailbox-only(E_NO_CHANNEL)");
    expect(existsSync(transcript)).toBe(false);
  });
});
