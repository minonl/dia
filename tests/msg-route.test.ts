import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// docs/design/workbench.md §7 —— 地址路由（track:/group:/session:）+ queue 出队
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

let root: string;
const savedEnv = { ...process.env };

function run(args: string[], session = "ses_a") {
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, DIA_ROOT: root, DIA_SESSION_ID: session, OPENCODE_SESSION_ID: "" },
  });
}

const now = () => new Date().toISOString();

function session(id: string) {
  const dir = join(root, "collab", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    schema: 1, session_id: id, host: "opencode", display_name: id, cwd: "/tmp",
    started_at: now(), last_seen: now(), capabilities: ["msg:v2"], address: `session:${id}`,
  }));
}

interface LiveOpts { liveness?: "alive" | "suspect" | "dead"; eligible?: boolean }
function snapshot(sessions: Record<string, LiveOpts>, asOf = now()) {
  const dir = join(root, "workbench", "derived");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({
    schema_v: 1, as_of: asOf, duration_ms: 1, depth: "fast", sources: {},
    tracks: [], worktrees: { schema_v: 1, repos: [] }, queue: { pending: 0, oldest_age_ms: null }, alerts: [],
    sessions: Object.entries(sessions).map(([session_id, o]) => ({
      schema_v: 1, session_id, host: "opencode", host_scope: "global", cwd: "/tmp", tracks: [],
      liveness: o.liveness || "alive", liveness_evidence: [], resumable: true,
      delivery_ready: (o.liveness || "alive") === "alive",
      route_eligible: o.eligible ?? (o.liveness || "alive") !== "dead",
    })),
  }, null, 1));
}

function track(id: string, binds: Array<{ session: string; role?: "lead" | "worker" | "reviewer"; at?: string }>) {
  const dir = join(root, "workbench");
  mkdirSync(dir, { recursive: true });
  const lines: any[] = [{ ts: now(), event: "open", id, title: id }];
  for (const b of binds) lines.push({ ts: b.at || now(), event: "bind", id, session: b.session, role: b.role || "worker" });
  writeFileSync(join(dir, "tracks.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function handoff(tr: string, from: string, to: string, at = now()) {
  const file = join(root, "workbench", "tracks.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ ts: at, event: "handoff", id: tr, from, to, reason: "handoff" }) + "\n");
}

function inboxFiles(id: string): any[] {
  const dir = join(root, "collab", "inbox", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function allInboxFiles(): string[] {
  const base = join(root, "collab", "inbox");
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(base, d.name))) if (f.endsWith(".json")) out.push(`${d.name}/${f}`);
  }
  return out;
}

function queueRows(): any[] {
  const file = join(root, "workbench", "queue.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-msg-route-"));
  mkdirSync(join(root, "collab", "sessions"), { recursive: true });
  for (const s of ["ses_a", "ses_lead", "ses_w1", "ses_w2", "ses_old", "ses_new", "ses_dead"]) session(s);
});

afterEach(() => {
  process.env = { ...savedEnv };
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a) 旧路径字节不变", () => {
  test("--to ses_x 不新增 to_addr/to_resolved", () => {
    const r = run(["msg", "send", "--to", "ses_lead", "--kind", "notify", "--subject", "hi", "--body", "yo"]);
    expect(r.status).toBe(0);
    const rows = inboxFiles("ses_lead");
    expect(rows.length).toBe(1);
    expect(rows[0].to.session_id).toBe("ses_lead");
    expect("to_addr" in rows[0]).toBe(false);
    expect("to_resolved" in rows[0]).toBe(false);
  });
});

describe("b) track 地址落 lead", () => {
  test("lead alive → 投 lead 且写 to_addr/to_resolved", () => {
    track("tr-x", [{ session: "ses_lead", role: "lead" }]);
    snapshot({ ses_lead: { liveness: "alive" } });
    const r = run(["msg", "send", "--to", "track:tr-x", "--kind", "question", "--subject", "q1", "--body", "b"]);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    const rows = inboxFiles("ses_lead");
    expect(rows.length).toBe(1);
    expect(rows[0].to_addr).toBe("track:tr-x");
    expect(rows[0].to_resolved).toBe("ses_lead");
    expect(rows[0].to.session_id).toBe("ses_lead");
  });

  test("lead suspect 且 route_eligible → 仍投（等 CI 场景）", () => {
    track("tr-x", [{ session: "ses_lead", role: "lead" }]);
    snapshot({ ses_lead: { liveness: "suspect", eligible: true } });
    const r = run(["msg", "send", "--to", "track:tr-x", "--subject", "s"]);
    expect(r.status).toBe(0);
    expect(inboxFiles("ses_lead").length).toBe(1);
  });

  test("lead dead → 回退到 eligible worker", () => {
    track("tr-x", [{ session: "ses_lead", role: "lead", at: "2026-01-02T00:00:00Z" }, { session: "ses_w1", at: "2026-01-01T00:00:00Z" }]);
    snapshot({ ses_lead: { liveness: "dead", eligible: false }, ses_w1: { liveness: "alive" } });
    const r = run(["msg", "send", "--to", "track:tr-x", "--subject", "s"]);
    expect(r.status).toBe(0);
    expect(inboxFiles("ses_w1").length).toBe(1);
    expect(inboxFiles("ses_lead").length).toBe(0);
  });

  test("track 不存在 → exit 2（E_ROUTE_ADDR）", () => {
    snapshot({});
    const r = run(["msg", "send", "--to", "track:tr-nope", "--subject", "s"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_ROUTE_ADDR");
    expect(allInboxFiles().length).toBe(0);
  });

  test("snapshot 缺失 → queued（exit 40, reason=snapshot-missing）", () => {
    track("tr-x", [{ session: "ses_lead", role: "lead" }]);
    const r = run(["msg", "send", "--to", "track:tr-x", "--subject", "s"]);
    expect(r.status).toBe(40);
    expect(r.stdout).toContain("reason=snapshot-missing");
    expect(queueRows().length).toBe(1);
    expect(allInboxFiles().length).toBe(0);
  });
});

describe("c) 全 dead → 入队 exit 40", () => {
  test("queue 恰 1 行、0 inbox 文件、同幂等键重复发不追加", () => {
    track("tr-x", [{ session: "ses_dead", role: "lead" }]);
    snapshot({ ses_dead: { liveness: "dead", eligible: false } });
    const r = run(["msg", "send", "--to", "track:tr-x", "--kind", "question", "--subject", "q", "--body", "b", "--idempotency-key", "k1"]);
    expect(r.status).toBe(40);
    expect(r.stdout).toMatch(/^queued q-\S+ addr=track:tr-x reason=no-route-eligible/m);
    expect(queueRows().length).toBe(1);
    expect(allInboxFiles().length).toBe(0);
    // 同 addr + 同幂等键再发一次 → 复用，不入新行
    const again = run(["msg", "send", "--to", "track:tr-x", "--kind", "question", "--subject", "q", "--body", "b", "--idempotency-key", "k1"]);
    expect(again.status).toBe(40);
    expect(queueRows().length).toBe(1);
  });
});

describe("d) handoff：旧地址 41 / track 落新 lead", () => {
  test("session:旧 → exit 41，--allow-moved 放行", () => {
    track("tr-h", [{ session: "ses_old", role: "lead", at: "2026-01-01T00:00:00Z" }]);
    handoff("tr-h", "ses_old", "ses_new", "2026-01-02T00:00:00Z");
    snapshot({ ses_old: { liveness: "dead", eligible: false }, ses_new: { liveness: "alive" } });

    const moved = run(["msg", "send", "--to", "session:ses_old", "--subject", "s"]);
    expect(moved.status).toBe(41);
    expect(moved.stderr).toContain("E_ROUTE_MOVED");
    expect(moved.stderr).toContain("ses_new");
    expect(allInboxFiles().length).toBe(0);

    const ok = run(["msg", "send", "--to", "session:ses_old", "--subject", "s", "--allow-moved"]);
    if (ok.status !== 0) console.error(ok.stdout, ok.stderr);
    expect(ok.status).toBe(0);
    const rows = inboxFiles("ses_old");
    expect(rows.length).toBe(1);
    expect(rows[0].refs.route_moved).toBe("1");
  });

  test("track 地址落新 lead", () => {
    track("tr-h", [{ session: "ses_old", role: "lead", at: "2026-01-01T00:00:00Z" }]);
    handoff("tr-h", "ses_old", "ses_new", "2026-01-02T00:00:00Z");
    snapshot({ ses_old: { liveness: "dead", eligible: false }, ses_new: { liveness: "alive" } });
    const r = run(["msg", "send", "--to", "track:tr-h", "--subject", "s"]);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(inboxFiles("ses_new").length).toBe(1);
    expect(inboxFiles("ses_old").length).toBe(0);
  });
});

describe("e) 出队：已投未 ack 不二次发送", () => {
  test("retry --queue 连跑两次只产生一个消息文件", () => {
    track("tr-x", [{ session: "ses_dead", role: "lead" }]);
    snapshot({ ses_dead: { liveness: "dead", eligible: false } });
    const q = run(["msg", "send", "--to", "track:tr-x", "--kind", "question", "--subject", "q", "--body", "b"]);
    expect(q.status).toBe(40);
    expect(queueRows().length).toBe(1);

    // 目标复活 → 第一次出队投递
    snapshot({ ses_dead: { liveness: "alive" } });
    const r1 = run(["msg", "retry", "--queue"]);
    if (r1.status !== 0) console.error(r1.stdout, r1.stderr);
    expect(r1.status).toBe(0);
    expect(inboxFiles("ses_dead").length).toBe(1);
    const row = queueRows()[0];
    expect(row.delivered_msg_id).toBeTruthy();
    expect(row.resolved_at).toBeTruthy();

    // 第二次：已 delivered 未 ack，也不产生新文件
    const r2 = run(["msg", "retry", "--queue"]);
    expect(r2.status).toBe(0);
    expect(inboxFiles("ses_dead").length).toBe(1);
  });
});

describe("f) 广播默认 notify", () => {
  test("notify 投全部 eligible；question 需 --fanout execute", () => {
    track("tr-x", [
      { session: "ses_lead", role: "lead", at: "2026-01-03T00:00:00Z" },
      { session: "ses_w1", at: "2026-01-02T00:00:00Z" },
      { session: "ses_w2", at: "2026-01-01T00:00:00Z" },
    ]);
    snapshot({ ses_lead: {}, ses_w1: {}, ses_w2: {} });

    const ok = run(["msg", "send", "--to", "track:tr-x/*", "--kind", "notify", "--subject", "n"]);
    if (ok.status !== 0) console.error(ok.stdout, ok.stderr);
    expect(ok.status).toBe(0);
    expect(allInboxFiles().length).toBe(3);

    const denied = run(["msg", "send", "--to", "track:tr-x/*", "--kind", "question", "--subject", "q"]);
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("E_FANOUT");
    expect(allInboxFiles().length).toBe(3);

    const exec = run(["msg", "send", "--to", "track:tr-x/*", "--kind", "question", "--subject", "q2", "--fanout", "execute"]);
    if (exec.status !== 0) console.error(exec.stdout, exec.stderr);
    expect(exec.status).toBe(0);
    expect(allInboxFiles().length).toBe(6);
  });
});

describe("g) 显式组", () => {
  test("group add 幂等 + group:g 只 notify", () => {
    const add = run(["collab", "group", "add", "g", "--session", "ses_w1"]);
    if (add.status !== 0) console.error(add.stdout, add.stderr);
    expect(add.status).toBe(0);
    const again = run(["collab", "group", "add", "g", "--session", "ses_w1"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already-member");

    const list = run(["collab", "group", "list", "--json"]);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([{ group: "g", members: ["ses_w1"] }]);

    snapshot({ ses_w1: { liveness: "alive" } });
    const ok = run(["msg", "send", "--to", "group:g", "--kind", "notify", "--subject", "n"]);
    if (ok.status !== 0) console.error(ok.stdout, ok.stderr);
    expect(ok.status).toBe(0);
    expect(inboxFiles("ses_w1").length).toBe(1);

    const denied = run(["msg", "send", "--to", "group:g", "--kind", "question", "--subject", "q"]);
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("E_FANOUT");

    // add 校验 session 存在
    const ghost = run(["collab", "group", "add", "g", "--session", "ses_ghost"]);
    expect(ghost.status).toBe(2);
    // remove 不存在的成员 → E_GROUP_MEMBER(2)
    const bad = run(["collab", "group", "remove", "g", "--session", "ses_w2"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("E_GROUP_MEMBER");
  });
});
