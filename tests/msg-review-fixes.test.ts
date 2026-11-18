// dia msg —— 对抗评审（炸毛）8 条里已复现的 6 条的回归测试
//
// 都是「静默失败」类问题：行为看起来正常（exit 0 / 有消息文件），但事件流、日志、
// 收件人校验、subject 传参里有具体缺失。每条都先断言**可观测的产物**，不只断言不报错。
//
// 覆盖：
//   1) acp_cmd 指向不存在的二进制 → inject.failed(E_ACP_SPAWN) + attempts + next_retry_at（防无限重投）
//   2) dia out --to <agent名> → E_USAGE，不落 inbox 孤儿目录，board 不列出
//   3) ACP 指针 prompt 里带**真实 subject**（原来恒为「(见 dia msg show)」）
//   4) 自动 ACP 通道落日志 collab/deliver/acp-auto-<id>.log（手动是 deliver-<id>.log）
//   5) close 的 from_state 是改之前的真实状态（原来恒为 closed→closed）
//   6) msg-import 的会话标识口径与 collab 统一（ses_abc.def 不被截断）
import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  root = mkdtempSync(join(tmpdir(), "dia-review-fix-"));
  transcript = join(root, "acp-transcript.jsonl");
});

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
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

const inboxFiles = (sid: string) => {
  const dir = join(root, "collab", "inbox", sid);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
};
const readMsg = (sid: string, id: string) => JSON.parse(readFileSync(join(root, "collab", "inbox", sid, `${id}.json`), "utf8"));
const firstId = (stdout: string) => stdout.split("\t")[0];

function waitFor(pred: () => boolean, ms = 10_000): boolean {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return pred();
}

describe("评审修复 1：ACP 子进程 spawn 失败必须落 inject.failed（防无限重投）", () => {
  test("同步：notify-acp 不再崩进程；写 inject.failed(E_ACP_SPAWN)+attempts+next_retry_at", () => {
    session("ses_spawn", { acp_cmd: "/no/such/binary-dia-test" });
    const sent = run(["out", "--to", "ses_spawn", "--subject", "spawn", "--body", "x"], { DIA_SESSION_ID: "ses_A" });
    expect(sent.status).toBe(0);
    const id = firstId(sent.stdout);

    const r = run(["msg", "notify-acp", "ses_spawn", id]);
    // 原来这里是 uncaught ENOENT → 进程崩（status 非 0 且无任何事件）
    expect(r.stderr).not.toContain("posix_spawn");
    expect(r.stderr).toContain("E_ACP_NOTIFY: E_ACP_SPAWN");

    const failed = events().find((e) => e.event === "inject.failed" && e.msg_id === id);
    expect(failed).toBeTruthy();
    expect(failed.transport).toBe("acp");
    expect(failed.error_code).toBe("E_ACP_SPAWN");

    // 关键：attempts 必须前进，否则 retryDue 里 (attempts||0) >= 3 永远不成立 → 每轮重投一个必崩的子进程
    const m = readMsg("ses_spawn", id);
    expect(m.attempts).toBe(1);
    expect(typeof m.next_retry_at).toBe("string");
    expect(Date.parse(m.next_retry_at)).toBeGreaterThan(Date.now() - 1000);
    expect(m.injected_at).toBeUndefined();
  });

  test("异步：send 自动通道 spawn 失败也写失败事件与退避（且落日志）", () => {
    session("ses_spawn2", { acp_cmd: "/no/such/binary-dia-test" });
    const r = run(["out", "--to", "ses_spawn2", "--subject", "spawn-async", "--body", "x"], { DIA_SESSION_ID: "ses_A" });
    expect(r.stdout).toContain("notified=acp(queued)");
    const id = firstId(r.stdout);

    const ok = waitFor(() => events().some((e) => e.event === "inject.failed" && e.msg_id === id));
    if (!ok) console.error("EVENTS:", JSON.stringify(events(), null, 1));
    expect(ok).toBe(true);
    const m = readMsg("ses_spawn2", id);
    expect(m.attempts).toBe(1);
    expect(typeof m.next_retry_at).toBe("string");
  });

  test("AcpClient 层：spawn 失败 → 请求 reject E_ACP_SPAWN（不抛 uncaught）", async () => {
    const { AcpClient } = await import("../src/acp.ts");
    const c = new AcpClient(["/no/such/binary-dia-test"], "/tmp", 5_000);
    try {
      let err: any = null;
      try { await c.init(); } catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(String(err.message)).toContain("E_ACP_SPAWN");
      // 失败被记住：后续请求立即失败，不再空等超时
      let err2: any = null;
      try { await c.newSession("/tmp"); } catch (e) { err2 = e; }
      expect(String(err2?.message)).toContain("E_ACP_SPAWN");
    } finally { c.close(); }
  });
});

describe("评审修复 2：dia out --to 只接受会话 id", () => {
  test("--to <agent名> → E_USAGE，且不创建 inbox 孤儿目录", () => {
    const r = run(["out", "--to", "dabo-redteam", "--subject", "交接", "--body", "body"], { DIA_SESSION_ID: "ses_A" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_USAGE");
    expect(r.stderr).toContain("收件人必须是会话 id");
    // 原来会静默落下 collab/inbox/dabo-redteam/
    expect(existsSync(join(root, "collab", "inbox", "dabo-redteam"))).toBe(false);
  });

  test("board 不把非法收件箱目录当会话（脏数据容错）", () => {
    // 模拟历史脏数据：直接放一个非 ses_ 命名的 inbox 目录 + 一条消息
    const dir = join(root, "collab", "inbox", "dabo-redteam");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "m-orphan.json"), JSON.stringify({
      schema: 2, id: "m-orphan", thread_id: "th-x", seq: 1,
      from: { session_id: "ses_A" }, to: { session_id: "dabo-redteam" },
      kind: "notify", subject: "orphan", body_bytes: 0, requires_reply: false, hops: 0,
      created_at: new Date().toISOString(), state: "pending", transport: "file", idempotency_key: "th-x#1",
    }));
    const r = run(["collab", "board", "--json", "--refresh"]);
    expect(r.status).toBe(0);
    const board = JSON.parse(r.stdout);
    expect(board.open).toBe(0);
    expect(JSON.stringify(board)).not.toContain("dabo-redteam");
  });

  test("session:ses_* 前缀仍接受（不完全拦死）", () => {
    const r = run(["out", "--to", "session:ses_B", "--subject", "s", "--body", "b"], { DIA_SESSION_ID: "ses_A" });
    expect(r.status).toBe(0);
    expect(inboxFiles("ses_B").length).toBe(1);
  });
});

describe("评审修复 3：ACP 指针 prompt 带真实 subject，并自动落 reply", () => {
  test("subject 真的传到目标（transcript 里的 prompt 正文）", () => {
    session("ses_subject", { acp_cmd: `node ${mockSession}` });
    const r = run(["out", "--to", "ses_subject", "--subject", "标题必须传过去", "--body", "x",
      "--kind", "question"], { DIA_SESSION_ID: "ses_A" });
    expect(r.status).toBe(0);
    const id = firstId(r.stdout);

    const ok = waitFor(() => existsSync(transcript));
    if (!ok) console.error("EVENTS:", JSON.stringify(events(), null, 1));
    expect(ok).toBe(true);
    const rows = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const prompt = rows.find((x) => x.method === "session/prompt");
    expect(prompt).toBeTruthy();
    const text = String(prompt.params?.prompt?.[0]?.text || "");
    expect(text).toContain(`[dia-msg ${id}] 标题必须传过去`);
    // 原实现恒为这个兜底串
    expect(text).not.toContain("(见 dia msg show)");
  });

  test("目标没自行 reply → ACP 返回文本落成 v2 reply（state=replied）", () => {
    session("ses_autoreply", { acp_cmd: `node ${mockSession}` });
    const r = run(["out", "--to", "ses_autoreply", "--subject", "自动回复", "--body", "x", "--kind", "question"],
      { DIA_SESSION_ID: "ses_A" });
    const id = firstId(r.stdout);
    const ok = waitFor(() => {
      try { return readMsg("ses_autoreply", id).state === "replied"; } catch { return false; }
    });
    if (!ok) console.error("EVENTS:", JSON.stringify(events(), null, 1));
    expect(ok).toBe(true);
    const m = readMsg("ses_autoreply", id);
    expect(m.state).toBe("replied");
    expect(typeof m.reply_id).toBe("string");
    // reply 消息落在原发件人的收件箱里，正文来自 ACP
    const rid = m.reply_id;
    expect(readMsg("ses_A", rid).body).toContain("acp-session-ok");
  });
});

describe("评审修复 4：自动 ACP 通道落日志", () => {
  test("collab/deliver/acp-auto-<id>.log 存在且有内容（能与手动 deliver-<id>.log 区分）", () => {
    session("ses_log", { acp_cmd: "/no/such/binary-dia-test" });
    const r = run(["out", "--to", "ses_log", "--subject", "log", "--body", "x"], { DIA_SESSION_ID: "ses_A" });
    const id = firstId(r.stdout);
    const log = join(root, "collab", "deliver", `acp-auto-${id}.log`);
    const ok = waitFor(() => existsSync(log) && readFileSync(log, "utf8").length > 0);
    if (!ok) console.error("deliver dir:", existsSync(join(root, "collab", "deliver")) ? readdirSync(join(root, "collab", "deliver")) : "(missing)");
    expect(ok).toBe(true);
    // 日志里应能看到失败原因（原来 stdio:ignore 全丢）
    expect(readFileSync(log, "utf8")).toContain("E_ACP_SPAWN");
  });
});

describe("评审修复 5：close 的 from_state 是改之前的真实状态", () => {
  test("收件人 close：delivered → closed（不是 closed→closed）", () => {
    run(["out", "--to", "ses_rcv", "--subject", "c", "--body", "b"], { DIA_SESSION_ID: "ses_A" });
    const id = inboxFiles("ses_rcv")[0].replace(/\.json$/, "");
    // 先 ack，造出一个非 pending 的真实状态
    expect(run(["ack", id], { DIA_SESSION_ID: "ses_rcv" }).status).toBe(0);
    const r = run(["close", id, "--reason", "done"], { DIA_SESSION_ID: "ses_rcv" });
    expect(r.status).toBe(0);
    const ev = events().find((e) => e.event === "closed" && e.msg_id === id);
    expect(ev).toBeTruthy();
    expect(ev.to_state).toBe("closed");
    expect(ev.from_state).toBe("acked");
    expect(ev.from_state).not.toBe("closed");
  });

  test("发送方撤回：pending → closed（from_state 不是 closed）", () => {
    const r0 = run(["out", "--to", "ses_rcv2", "--subject", "c", "--body", "b"], { DIA_SESSION_ID: "ses_A" });
    const id = firstId(r0.stdout);
    const r = run(["close", id, "--reason", "dropped"], { DIA_SESSION_ID: "ses_A" });
    expect(r.status).toBe(0);
    const ev = events().find((e) => e.event === "closed" && e.msg_id === id);
    expect(ev).toBeTruthy();
    expect(ev.from_state).toBe("pending");
  });
});

describe("评审修复 6：msg-import 会话标识口径与 collab 统一", () => {
  test("目录名 ses_abc.def 不被截断成 ses_abc", async () => {
    const { sessionIdFromAgentDir } = await import("../src/msg-import.ts");
    expect(sessionIdFromAgentDir("ses_abc.def")).toBe("ses_abc.def");
    expect(sessionIdFromAgentDir("ses_a-b_c.1")).toBe("ses_a-b_c.1");
    expect(sessionIdFromAgentDir("session:ses_x")).toBe("ses_x");
    // 非会话 / 路径穿越一律不猜
    expect(sessionIdFromAgentDir("dabo-redteam")).toBeNull();
    expect(sessionIdFromAgentDir("ses_a..b")).toBeNull();
  });

  test("导入实际落到 ses_abc.def 收件箱（不是 ses_abc）", () => {
    const v1 = join(root, "msg", "ses_abc.def", "inbox");
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, "m-old1.json"), JSON.stringify({
      id: "m-old1", thread_id: "th-old", seq: 1, from: "ses_src", to: "ses_abc.def",
      kind: "notify", subject: "老消息", body: "b", state: "pending", created_at: new Date().toISOString(),
    }));
    const r = run(["msg", "migrate", "--apply", "--json"]);
    expect(r.status).toBe(0);
    expect(inboxFiles("ses_abc.def")).toEqual(["m-old1.json"]);
    expect(existsSync(join(root, "collab", "inbox", "ses_abc"))).toBe(false);
  });
});
