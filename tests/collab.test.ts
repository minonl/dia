import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

describe("dia msg migrate：旧数据只读迁移", () => {
  test("dry-run 不落盘，实际迁移复制正文，源文件删除后仍可读", () => {
    const oldDir = join(root, "msg", "旧会话", "inbox");
    mkdirSync(oldDir, { recursive: true });
    const oldBody = join(root, "old-body.md");
    writeFileSync(oldBody, "旧正文\n");
    writeFileSync(join(oldDir, "m-old1.json"), JSON.stringify({
      id: "m-old1", thread_id: "th-old", seq: 1, from: "yan", to: "旧会话",
      kind: "handoff", subject: "旧消息", body_file: oldBody, requires_reply: true,
      hops: 0, idempotency_key: "th-old#1", created_at: "2026-11-05T00:00:00Z", state: "pending",
    }));
    const dry = json(run(["msg", "migrate", "--dry-run", "--json"], "ses_b").stdout);
    expect(dry.migrated).toBe(0);
    const real = json(run(["msg", "migrate", "--json"], "ses_b").stdout);
    expect(real.migrated).toBe(1);
    rmSync(oldBody);
    const legacy = json(run(["in", "--legacy", "--json"], "ses_b").stdout);
    expect(legacy[0].subject).toBe("旧消息");
    expect(legacy[0].body).toBe("旧正文\n");
    expect(legacy[0].body_missing).toBeFalsy();
  });
});
