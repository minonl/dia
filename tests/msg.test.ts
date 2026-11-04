import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, "msg", ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_MSG_ROOT: root },
});
const json = (s: string) => JSON.parse(s);

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "dia-msg-")); });

describe("dia msg 文件邮箱", () => {
  let id = "";
  let thread = "";

  test("send 落到收件方 inbox，状态 pending", () => {
    const r = run(["send", "ops", "--from", "reviewer", "--kind", "question", "--subject", "S1", "--body", "B1", "--json"]);
    expect(r.status).toBe(0);
    const m = json(r.stdout);
    expect(m.state).toBe("pending");
    expect(m.requires_reply).toBe(true);
    id = m.id; thread = m.thread_id;
    const inbox = json(run(["inbox", "ops", "--json"]).stdout);
    expect(inbox.length).toBe(1);
    expect(inbox[0].id).toBe(id);
  });

  test("ack 只由目标侧改写状态", () => {
    const r = run(["ack", "ops", id, "--json"]);
    expect(r.status).toBe(0);
    expect(json(r.stdout).state).toBe("acked");
    expect(json(r.stdout).ack_at).toBeTruthy();
  });

  test("reply 生成同 thread 的 seq+1，原消息置 replied", () => {
    const r = run(["reply", "ops", id, "--body", "收到", "--json"]);
    expect(r.status).toBe(0);
    const { reply } = json(r.stdout);
    expect(reply.kind).toBe("reply");
    expect(reply.thread_id).toBe(thread);
    expect(reply.seq).toBe(2);
    const t = json(run(["thread", thread, "--json"]).stdout);
    expect(t.length).toBe(2);
    expect(t[0].state).toBe("replied");
    expect(t[0].reply_id).toBe(reply.id);
  });

  test("escalate 只处理过期未回复的消息", () => {
    run(["send", "ops", "--from", "reviewer", "--kind", "notify", "--subject", "late", "--deadline", "2020-01-01T00:00:00Z"]);
    run(["send", "ops", "--from", "reviewer", "--kind", "notify", "--subject", "future", "--deadline", "2999-01-01T00:00:00Z"]);
    const rows = json(run(["escalate", "--json"]).stdout);
    expect(rows.map((m: any) => m.subject)).toEqual(["late"]);
    const inbox = json(run(["inbox", "ops", "--json"]).stdout);
    const future = inbox.find((m: any) => m.subject === "future");
    expect(future.state).toBe("pending");
  });

  test("hops ≥3 拒绝继续往返", () => {
    let cur = json(run(["send", "b", "--from", "a", "--kind", "question", "--subject", "ping", "--json"]).stdout);
    for (let i = 0; i < 3; i++) {
      const agent = i % 2 === 0 ? "b" : "a";
      const r = run(["reply", agent, cur.id, "--body", "pong", "--json"]);
      if (r.status !== 0) { expect(r.stderr).toContain("E_HOPS"); return; }
      cur = json(r.stdout).reply;
    }
    const r = run(["reply", cur.to, cur.id, "--body", "again", "--json"]);
    expect(r.status).not.toBe(0);
  });
});
