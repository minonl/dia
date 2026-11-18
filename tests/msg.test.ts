import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// v2 单一存储：收件人一律是会话 id，消息只落在 ~/.dia/collab/inbox/<sid>/
let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, "msg", ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_SESSION_ID: "", OPENCODE_SESSION_ID: "", ...env },
});
const json = (s: string) => JSON.parse(s);
const A = { DIA_SESSION_ID: "ses_a" };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dia-msg-v2-"));
  // 两个会话各注册一次（whoami），后续 send 才有 display_name/pane 依据
  run(["inbox", "--json"], { DIA_SESSION_ID: "ses_a" });
  run(["inbox", "--json"], { DIA_SESSION_ID: "ses_b" });
});

describe("dia msg（v2 单一存储）", () => {
  let id = "";
  let thread = "";

  test("send --to ses_b → 落在 collab/inbox/ses_b，pending", () => {
    const r = run(["send", "--to", "ses_b", "--kind", "question", "--subject", "S1", "--body", "B1", "--json"], A);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    const m = json(r.stdout);
    expect(m.state).toBe("pending");
    expect(m.requires_reply).toBe(true);
    expect(m.to.session_id).toBe("ses_b");
    expect(existsSync(join(root, "collab", "inbox", "ses_b", `${m.id}.json`))).toBe(true);
    id = m.id; thread = m.thread_id;
  });

  test("位置参数形态 send ses_b 等价于 --to ses_b", () => {
    const r = run(["send", "ses_b", "--kind", "notify", "--subject", "pos", "--json"], A);
    expect(r.status).toBe(0);
    expect(json(r.stdout).to.session_id).toBe("ses_b");
  });

  test("inbox（无位置参数）= 目标会话收件箱", () => {
    const rows = json(run(["inbox", "--json"], { DIA_SESSION_ID: "ses_b" }).stdout);
    expect(rows.some((m: any) => m.id === id)).toBe(true);
  });

  test("show 只按 id（不再需要 agent）", () => {
    const m = json(run(["show", id, "--json"], { DIA_SESSION_ID: "ses_b" }).stdout);
    expect(m.id).toBe(id);
    expect(m.body).toBe("B1");
  });

  test("status 是 show 的别名", () => {
    const r = run(["status", id, "--json"], { DIA_SESSION_ID: "ses_b" });
    expect(r.status).toBe(0);
    expect(json(r.stdout).id).toBe(id);
  });

  test("ack 由收件人改写状态", () => {
    const r = run(["ack", id, "--json"], { DIA_SESSION_ID: "ses_b" });
    expect(r.status).toBe(0);
    expect(json(r.stdout).state).toBe("acked");
  });

  test("reply 生成同 thread 的 seq+1，原消息置 replied", () => {
    const r = run(["reply", id, "--body", "收到", "--json"], { DIA_SESSION_ID: "ses_b" });
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    const rep = json(r.stdout).reply;
    expect(rep.kind).toBe("reply");
    expect(rep.thread_id).toBe(thread);
    expect(rep.seq).toBe(2);
    expect(run(["show", id, "--json"], { DIA_SESSION_ID: "ses_b" }).stdout).toContain('"replied"');
  });

  test("trace 能看到 send → read → ack → reply", () => {
    const r = run(["trace", id], { DIA_SESSION_ID: "ses_b" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("send.accepted");
    expect(r.stdout).toContain("acked");
    expect(r.stdout).toContain("replied");
  });

  test("hops ≥3 拒绝继续往返", () => {
    let cur = json(run(["send", "--to", "ses_b", "--kind", "question", "--subject", "ping", "--json"], A).stdout);
    for (let i = 0; i < 3; i++) {
      const sid = i % 2 === 0 ? "ses_b" : "ses_a";
      const r = run(["reply", cur.id, "--body", "pong", "--json"], { DIA_SESSION_ID: sid });
      if (r.status !== 0) { expect(r.stderr).toContain("E_HOPS"); return; }
      cur = json(r.stdout).reply;
    }
    const r = run(["reply", cur.id, "--body", "again", "--json"], { DIA_SESSION_ID: "ses_a" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("E_HOPS");
  });
});

describe("dia msg 不再按名字形状分流", () => {
  test("send <非会话 id> → 报错，不写任何存储", () => {
    const before = run(["inbox", "--json"], { DIA_SESSION_ID: "ses_b" }).stdout;
    const r = run(["send", "ops", "--kind", "notify", "--subject", "x", "--json"], A);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_USAGE");
    expect(r.stderr).toContain("ses_");
    // 不落到 v1 目录（v1 已下线，连目录都不该新建）
    expect(existsSync(join(root, "msg"))).toBe(false);
    expect(run(["inbox", "--json"], { DIA_SESSION_ID: "ses_b" }).stdout).toBe(before);
  });

  test("session:ses_x 前缀被接受（归一成 ses_x）", () => {
    const r = run(["send", "session:ses_b", "--kind", "notify", "--subject", "prefixed", "--json"], A);
    expect(r.status).toBe(0);
    expect(json(r.stdout).to.session_id).toBe("ses_b");
  });

  test("inbox <agent名> → 报错而非查 v1", () => {
    const r = run(["inbox", "ops", "--json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_USAGE");
  });

  test("已下线子命令给出替代命令", () => {
    for (const sub of ["needs-info", "stuck", "thread", "agents", "delivered"]) {
      const r = run([sub, "x"], A);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("E_RETIRED");
    }
  });
});
