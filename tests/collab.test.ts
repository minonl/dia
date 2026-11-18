import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

function run(args: string[], session?: string) {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    DIA_ROOT: root,
    DIA_SESSION_ID: session || "",
    OPENCODE_SESSION_ID: "",
  };
  return spawnSync("bun", [cli, ...args], { encoding: "utf8", env });
}
const json = (s: string) => JSON.parse(s);

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "dia-collab-")); });

describe("whoami 保留 pane 绑定", () => {
  test("外部再跑 whoami（无 TMUX_PANE）不清掉已有 pane", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-pane-keep-"));
    const env = { ...process.env, DIA_ROOT: home, DIA_HOME: home, TMUX_PANE: "" };
    const sdir = join(home, "collab", "sessions"); mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "ses_p.json"), JSON.stringify({
      schema: 1, session_id: "ses_p", host: "opencode", display_name: "p", cwd: "/tmp",
      started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
      capabilities: ["msg:v2"], address: "session:ses_p", pane: "%9", pane_pid: "1", pane_cwd: "/tmp",
    }));
    const r = spawnSync("bun", [cli, "whoami", "--session", "ses_p"], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(sdir, "ses_p.json"), "utf8")).pane).toBe("%9");
  });
});

describe("dia collab M0：会话身份与送达", () => {
  test("whoami 解析 --session 并注册两个不同会话", () => {
    const a = json(run(["whoami", "--json"], "ses_a").stdout);
    const b = json(run(["whoami", "--json"], "ses_b").stdout);
    expect(a.session_id).toBe("ses_a");
    expect(b.session_id).toBe("ses_b");
    expect(a.session_id).not.toBe(b.session_id);
    expect(readFileSync(join(root, "collab", "sessions", "ses_a.json"), "utf8")).toContain("ses_a");
  });

  test("没有会话标识时明确报错，不猜", () => {
    const r = run(["whoami", "--json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_NO_SESSION");
  });

  test("out 的正文来自 body-file，删除源文件后仍可读", () => {
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "第一行\n第二行\n");
    const sent = json(run(["out", "--to", "ses_b", "--subject", "文件正文", "--body-file", bodyFile, "--json"], "ses_a").stdout);
    expect(sent.to.session_id).toBe("ses_b");
    expect(sent.from.session_id).toBe("ses_a");
    rmSync(bodyFile);
    const inbox = json(run(["in", "--json"], "ses_b").stdout);
    const m = inbox.find((x: any) => x.id === sent.id);
    expect(m.body).toBe("第一行\n第二行\n");
    expect(m.state).toBe("delivered");
  });

  test("ack/reply/close 形成闭环，原消息不被静默丢弃", () => {
    const sent = json(run(["out", "--to", "ses_b", "--subject", "闭环", "--body", "ping", "--kind", "question", "--json"], "ses_a").stdout);
    expect(sent.requires_reply).toBe(true);
    run(["in", "--no-mark"], "ses_b");
    expect(json(run(["ack", sent.id, "--json"], "ses_b").stdout).state).toBe("acked");
    const rep = json(run(["reply", sent.id, "--body", "pong", "--json"], "ses_b").stdout);
    expect(rep.reply.kind).toBe("reply");
    expect(rep.reply.hops).toBe(1);
    expect(rep.original.state).toBe("replied");
    const closed = json(run(["close", sent.id, "--reason", "done", "--json"], "ses_b").stdout);
    expect(closed.closure_reason).toBe("done");
    const sender = json(run(["in", "--all", "--json"], "ses_a").stdout);
    expect(sender.some((x: any) => x.id === rep.reply.id)).toBe(true);
  });

  test("同一 idempotency-key 不重复投递", () => {
    const a = json(run(["out", "--to", "ses_b", "--subject", "幂等", "--body", "x", "--thread", "th-fixed", "--idempotency-key", "k1", "--json"], "ses_a").stdout);
    const b = json(run(["out", "--to", "ses_b", "--subject", "幂等", "--body", "x", "--thread", "th-fixed", "--idempotency-key", "k1", "--json"], "ses_a").stdout);
    expect(b.id).toBe(a.id);
    const inbox = json(run(["in", "--all", "--json"], "ses_b").stdout);
    expect(inbox.filter((x: any) => x.thread_id === "th-fixed").length).toBe(1);
  });

  test("终态不可被 ack/reply 复活", () => {
    const sent = json(run(["out", "--to", "ses_b", "--subject", "终态", "--body", "x", "--json"], "ses_a").stdout);
    run(["in", "--no-mark"], "ses_b");
    run(["close", sent.id, "--reason", "done"], "ses_b");
    const ack = run(["ack", sent.id], "ses_b");
    expect(ack.status).toBe(22);
    expect(ack.stderr).toContain("E_STATE");
    const rep = run(["reply", sent.id, "--body", "late"], "ses_b");
    expect(rep.status).toBe(22);
    expect(rep.stderr).toContain("E_STATE");
    const again = json(run(["close", sent.id, "--reason", "done", "--json"], "ses_b").stdout);
    expect(again.state).toBe("closed");
  });

  test("dia msg send 位置参数是 session id；--from 不能伪装成别的会话", () => {
    const r = run(["msg", "send", "ses_b", "--subject", "位置参数", "--body", "ok", "--json"], "ses_a");
    expect(r.status).toBe(0);
    expect(json(r.stdout).from.session_id).toBe("ses_a");
    const inbox = json(run(["in", "--all", "--json"], "ses_b").stdout);
    expect(inbox.some((x: any) => x.subject === "位置参数")).toBe(true);
    // 伪造 --from：拒绝（身份由 DIA_SESSION_ID 决定）
    const fake = run(["msg", "send", "ses_b", "--from", "ses_victim", "--subject", "伪造", "--body", "x", "--json"], "ses_a");
    expect(fake.status).toBe(2);
    expect(fake.stderr).toContain("不能伪装");
    // 与自身一致时允许（旧脚本兼容）
    const same = run(["msg", "send", "ses_b", "--from", "ses_a", "--subject", "兼容", "--body", "x", "--json"], "ses_a");
    expect(same.status).toBe(0);
  });
});

describe("dia msg migrate：旧数据一次性导入 v2（默认 dry-run）", () => {
  test("dry-run 不落盘；--apply 导入后能 show/reply（正文缺失标记 body_missing）", () => {
    const oldDir = join(root, "msg", "ses_old", "inbox");
    mkdirSync(oldDir, { recursive: true });
    const oldBody = join(root, "old-body.md");
    writeFileSync(oldBody, "旧正文\n");
    writeFileSync(join(oldDir, "m-old1.json"), JSON.stringify({
      id: "m-old1", thread_id: "th-old", seq: 1, from: "ses_src", to: "ses_old",
      kind: "handoff", subject: "旧消息", body_file: oldBody, requires_reply: true,
      hops: 0, idempotency_key: "th-old#1", created_at: "2026-11-05T00:00:00Z", state: "pending",
    }));
    const dry = json(run(["msg", "migrate", "--dry-run", "--json"], "ses_old").stdout);
    expect(dry.imported).toBe(1);
    // dry-run 不写盘
    expect(existsSync(join(root, "collab", "inbox", "ses_old", "m-old1.json"))).toBe(false);
    const real = json(run(["msg", "migrate", "--apply", "--json"], "ses_old").stdout);
    expect(real.imported).toBe(1);
    const shown = json(run(["msg", "show", "m-old1", "--json"], "ses_old").stdout);
    expect(shown.subject).toBe("旧消息");
    // v1 的 body_file 不再沿用（旧路径可能已失效）：导入时按「正文缺失」标记，不猜
    expect(shown.body_missing).toBe(true);
    // 导入后可用可回复（不是 legacy 只读）
    const rep = run(["msg", "reply", "m-old1", "--body", "已处理", "--json"], "ses_old");
    expect(rep.status).toBe(0);
    // 幂等：再跑一次不会重复导入
    const again = json(run(["msg", "migrate", "--apply", "--json"], "ses_old").stdout);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    // 旧文件保留（不删）
    expect(existsSync(join(oldDir, "m-old1.json"))).toBe(true);
  });

  test("提取不到会话 id 的旧目录：进报告、不导入、不崩", () => {
    const oldDir = join(root, "msg", "旧会话", "inbox");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "m-x.json"), JSON.stringify({ id: "m-x", subject: "s", body: "b" }));
    const r = run(["msg", "migrate", "--apply", "--json"], "ses_b");
    expect(r.status).toBe(0);
    const rep = json(r.stdout);
    expect(rep.imported).toBe(0);
    expect(rep.unresolved.map((u: any) => u.agent_dir)).toContain("旧会话");
    expect(existsSync(join(root, "collab", "inbox", "旧会话"))).toBe(false);
  });

  test("body_ref 路径穿越被拦截", () => {
    const dir = join(root, "collab", "inbox", "ses_b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "secret.txt"), "SECRET");
    writeFileSync(join(dir, "m-evil.json"), JSON.stringify({
      schema: 2, id: "m-evil", thread_id: "th-evil2", seq: 1,
      from: { session_id: "ses_a" }, to: { session_id: "ses_b" },
      kind: "notify", subject: "evil", body_ref: "../../secret.txt",
      requires_reply: false, hops: 0, idempotency_key: "th-evil2#1",
      created_at: "2026-11-05T00:00:00Z", state: "pending", transport: "file",
    }));
    const m = json(run(["show", "m-evil", "--json"], "ses_b").stdout);
    expect(m.body).toBe("");
  });

  test("导入拒绝路径穿越 id，不写到 inbox 外", () => {
    const oldDir = join(root, "msg", "ses_evil", "inbox");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "evil.json"), JSON.stringify({
      id: "../../escape", thread_id: "th-evil", seq: 1, from: "ses_a", to: "ses_evil",
      kind: "notify", subject: "evil", body: "x", requires_reply: false,
      hops: 0, idempotency_key: "th-evil#1", created_at: "2026-11-05T00:00:00Z", state: "pending",
    }));
    const r = json(run(["msg", "migrate", "--apply", "--json"], "ses_b").stdout);
    expect(r.invalid).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, "escape.json"))).toBe(false);
    expect(existsSync(join(root, "collab", "escape.json"))).toBe(false);
  });
});
