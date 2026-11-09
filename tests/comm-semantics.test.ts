import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], session?: string) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env as Record<string, string>, DIA_ROOT: root, DIA_SESSION_ID: session || "ses_a", OPENCODE_SESSION_ID: "" },
});
const json = (s: string) => JSON.parse(s);
const msgFiles = (sid: string) => {
  const dir = join(root, "collab", "inbox", sid);
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)); } catch { return []; }
};
const readMsg = (sid: string, id: string) => JSON.parse(readFileSync(join(root, "collab", "inbox", sid, `${id}.json`), "utf8"));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-comm-")); });

describe("通信三态：delivered / exposed / acked", () => {
  test("out 快照优先级；in 先展示后落 delivered；--expose 写 exposed_at", () => {
    const sent = json(run(["out", "--to", "ses_b", "--subject", "S", "--body", "B", "--json"], "ses_a").stdout);
    expect(sent.class_snapshot).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(sent.class_why)).toBe(true);

    const inbox = run(["in", "--json"], "ses_b");
    expect(inbox.status).toBe(0);
    const shown = json(inbox.stdout).find((m: any) => m.id === sent.id);
    expect(shown.state).toBe("delivered");
    expect(shown.body).toBe("B");

    const after = readMsg("ses_b", sent.id);
    expect(after.delivered_at).toBeTruthy();
    expect(after.exposed_at).toBeUndefined();

    const exposed = run(["in", "--expose", "--json"], "ses_b");
    expect(exposed.status).toBe(0);
    expect(readMsg("ses_b", sent.id).exposed_at).toBeTruthy();
  });

  test("ack 从 pending 直达也会补 delivered_at / first_touch_at", () => {
    const sent = json(run(["out", "--to", "ses_b", "--subject", "S2", "--json"], "ses_a").stdout);
    const ack = run(["ack", sent.id, "--json"], "ses_b");
    expect(ack.status).toBe(0);
    const m = readMsg("ses_b", sent.id);
    expect(m.state).toBe("acked");
    expect(m.delivered_at).toBeTruthy();
    expect(m.first_touch_at).toBeTruthy();
  });

  test("out --reply-to 把原消息置 replied（不再永久 pending）", () => {
    const q = json(run(["out", "--to", "ses_b", "--kind", "question", "--subject", "Q", "--json"], "ses_a").stdout);
    const r = json(run(["out", "--to", "ses_a", "--kind", "reply", "--thread", q.thread_id, "--reply-to", q.id, "--subject", "Re: Q", "--json"], "ses_b").stdout);
    expect(r.reply_to).toBe(q.id);
    const orig = readMsg("ses_b", q.id);
    expect(orig.state).toBe("replied");
    expect(orig.replied_at).toBeTruthy();
    expect(orig.reply_id).toBe(r.id);
  });
});

describe("消息优先级与排序", () => {
  test("发送者 doing P0 → 消息 P0；in 默认按 class 排序", () => {
    const t = json(run(["task", "add", "高优任务", "--owner", "ses_a", "--prio", "P0", "--json"], "ses_a").stdout);
    run(["task", "status", t.id, "doing"], "ses_a");
    const hot = json(run(["out", "--to", "ses_b", "--kind", "question", "--subject", "hot", "--json"], "ses_a").stdout);
    expect(hot.class_snapshot).toBe(0);

    const cold = json(run(["out", "--to", "ses_b", "--subject", "cold", "--json"], "ses_c").stdout);
    expect(cold.class_snapshot).toBeGreaterThan(0);

    const rows = json(run(["in", "--json"], "ses_b").stdout);
    expect(rows[0].id).toBe(hot.id);
    expect(rows.find((m: any) => m.id === cold.id).class).toMatch(/^P[0-3]$/);
  });

  test("--sort arrival 回到到达顺序；--class P0 过滤", () => {
    const t = json(run(["task", "add", "P0", "--owner", "ses_a", "--prio", "P0", "--json"], "ses_a").stdout);
    run(["task", "status", t.id, "doing"], "ses_a");
    const first = json(run(["out", "--to", "ses_b", "--subject", "first", "--json"], "ses_c").stdout);
    const second = json(run(["out", "--to", "ses_b", "--kind", "question", "--subject", "second", "--json"], "ses_a").stdout);
    const arrival = json(run(["in", "--sort", "arrival", "--json"], "ses_b").stdout);
    expect(arrival[0].id).toBe(first.id);
    const only = json(run(["in", "--class", "P0", "--json"], "ses_b").stdout);
    expect(only.map((m: any) => m.id)).toEqual([second.id]);
  });
});

describe("锁与顺序健壮性", () => {
  test("死进程留下的锁可立即回收（不再 30s 卡死）", () => {
    mkdirSync(join(root, "collab", ".locks"), { recursive: true });
    writeFileSync(join(root, "collab", ".locks", "thread-thx.lock"), JSON.stringify({ pid: 999999, token: "dead", at: Date.now() }));
    const r = run(["out", "--to", "ses_b", "--thread", "thx", "--subject", "after-crash", "--json"], "ses_a");
    expect(r.status).toBe(0);
  });

  test("历史消息按时间解析排序（+08:00 不再排错）", () => {
    // 手写两条消息：late 的本地时间 10:00+08:00 = 02:00Z，实际早于 03:00Z
    mkdirSync(join(root, "collab", "inbox", "ses_b"), { recursive: true });
    const base = { schema: 2, thread_id: "th1", seq: 1, from: { session_id: "ses_a", display_name: "a" }, to: { session_id: "ses_b", display_name: "b" }, kind: "notify", subject: "", requires_reply: false, hops: 0, idempotency_key: "", state: "pending", transport: "file" };
    writeFileSync(join(root, "collab", "inbox", "ses_b", "m-late.json"), JSON.stringify({ ...base, id: "m-late", subject: "late", created_at: "2026-11-09T10:00:00+08:00" }));
    writeFileSync(join(root, "collab", "inbox", "ses_b", "m-early.json"), JSON.stringify({ ...base, id: "m-early", subject: "early", created_at: "2026-11-09T03:00:00Z" }));
    const rows = json(run(["in", "--sort", "arrival", "--no-mark", "--json"], "ses_b").stdout);
    expect(rows.map((m: any) => m.id)).toEqual(["m-late", "m-early"]);
  });
});

describe("collab stats（cohort / backlog）", () => {
  test("送达率/回复率/时长/积压口径", () => {
    const now = "2026-11-09T10:00:00Z";
    const mk = (id: string, o: any) => ({
      schema: 2, thread_id: "th-" + id, seq: 1,
      from: { session_id: "ses_a", display_name: "a" }, to: { session_id: o.to || "ses_b", display_name: "b" },
      kind: o.kind || "question", subject: id, requires_reply: o.requires_reply ?? true, hops: 0,
      idempotency_key: id, created_at: o.created_at, state: o.state || "pending", transport: "file",
      ...(o.delivered_at ? { delivered_at: o.delivered_at } : {}),
      ...(o.exposed_at ? { exposed_at: o.exposed_at } : {}),
      ...(o.replied_at ? { replied_at: o.replied_at } : {}),
      ...(o.class_snapshot !== undefined ? { class_snapshot: o.class_snapshot } : {}),
    });
    mkdirSync(join(root, "collab", "inbox", "ses_b"), { recursive: true });
    mkdirSync(join(root, "collab", "sessions"), { recursive: true });
    writeFileSync(join(root, "collab", "sessions", "ses_b.json"), JSON.stringify({ schema: 1, session_id: "ses_b", last_seen: now }));
    const rows: Record<string, any> = {
      "m-1": mk("m-1", { created_at: "2026-11-09T08:00:00Z", delivered_at: "2026-11-09T08:10:00Z", exposed_at: "2026-11-09T08:11:00Z", replied_at: "2026-11-09T09:00:00Z", state: "replied", class_snapshot: 0 }),
      "m-2": mk("m-2", { created_at: "2026-11-09T09:30:00Z", delivered_at: "2026-11-09T09:31:00Z", state: "delivered", class_snapshot: 1 }),
    };
    for (const [id, m] of Object.entries(rows)) writeFileSync(join(root, "collab", "inbox", "ses_b", `${id}.json`), JSON.stringify(m));
    // 孤儿收件箱（没有 session 记录）
    mkdirSync(join(root, "collab", "inbox", "ses_dead"), { recursive: true });
    writeFileSync(join(root, "collab", "inbox", "ses_dead", "m-3.json"), JSON.stringify(mk("m-3", { to: "ses_dead", created_at: "2026-11-09T09:50:00Z", kind: "notify", requires_reply: false })));

    const st = json(run(["collab", "stats", "--since", "1d", "--now", now, "--json"]).stdout);
    expect(st.cohort.total).toBe(3);
    expect(st.cohort.delivered_rate).toBeCloseTo(2 / 3, 3);
    expect(st.cohort.exposed_rate).toBeCloseTo(1 / 3, 3);
    expect(st.cohort.reply_rate).toBe(0.5);
    expect(st.cohort.reply_latency_ms.n).toBe(1);
    expect(st.cohort.reply_latency_ms.median).toBe(60 * 60 * 1000);
    expect(st.cohort.reply_latency_ms.censored).toBe(1);
    expect(st.backlog.count).toBe(2); // m-2 delivered + m-3 pending
    expect(st.backlog.orphan).toBe(1);

    const byPair = json(run(["collab", "stats", "--since", "1d", "--now", now, "--by", "pair", "--json"]).stdout);
    expect(byPair.groups.map((g: any) => g.key).sort()).toEqual(["ses_a→ses_b", "ses_a→ses_dead"]);
  });
});
