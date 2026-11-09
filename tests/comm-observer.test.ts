import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env as Record<string, string>, DIA_ROOT: root },
});
const json = (s: string) => JSON.parse(s);

const now = "2026-11-09T10:00:00Z";
const mk = (id: string, o: any) => ({
  schema: 2, id, thread_id: "th-" + id, seq: 1,
  from: { session_id: "ses_a", display_name: "a" }, to: { session_id: o.to || "ses_b", display_name: "b" },
  kind: o.kind || "question", subject: o.subject || id, requires_reply: o.requires_reply ?? true,
  hops: 0, idempotency_key: id, created_at: o.created_at, state: o.state || "pending",
  transport: "file",
  ...(o.delivered_at ? { delivered_at: o.delivered_at } : {}),
  ...(o.class_snapshot !== undefined ? { class_snapshot: o.class_snapshot } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-obs-"));
  mkdirSync(join(root, "collab", "inbox", "ses_b"), { recursive: true });
  const rows = {
    "m-p0": mk("m-p0", { created_at: "2026-11-09T08:00:00Z", class_snapshot: 0 }), // 2h 未送达 → escalation
    "m-p2": mk("m-p2", { created_at: "2026-11-09T09:50:00Z", class_snapshot: 2, delivered_at: "2026-11-09T09:51:00Z" }),
  };
  for (const [id, m] of Object.entries(rows)) writeFileSync(join(root, "collab", "inbox", "ses_b", `${id}.json`), JSON.stringify(m));
});

describe("dia collab observer（M3a：只读看板）", () => {
  test("observe --once 产出 board/metrics/escalations，且 0600", () => {
    const r = run(["collab", "observe", "--once", "--now", now, "--json"]);
    expect(r.status).toBe(0);
    const b = json(r.stdout);
    expect(b.open).toBe(2);
    expect(b.p0).toBe(1);
    expect(b.undelivered).toBe(1);
    expect(b.escalations).toBe(1);
    expect(b.top[0].id).toBe("m-p0");

    const board = join(root, "collab", "state", "board.json");
    expect(existsSync(board)).toBe(true);
    expect(statSync(board).mode & 0o777).toBe(0o600);
    const esc = readFileSync(join(root, "collab", "escalations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(esc.length).toBe(1);
    expect(esc[0].id).toBe("m-p0");
    expect(JSON.stringify(esc[0])).not.toContain("body");
    expect(existsSync(join(root, "collab", "metrics", "2026-11-09.json"))).toBe(true);
  });

  test("board 读缓存；缺失时内存现算且不写盘", () => {
    run(["collab", "observe", "--once", "--now", now]);
    const b1 = json(run(["collab", "board", "--json", "--now", now]).stdout);
    expect(b1.open).toBe(2);
    expect(b1.stale).toBe(false);
    // 删除缓存：board 仍可用，但不得写盘（hook 只读）
    const board = join(root, "collab", "state", "board.json");
    const fs = require("node:fs");
    fs.rmSync(board);
    const b2 = json(run(["collab", "board", "--json", "--now", now]).stdout);
    expect(b2.open).toBe(2);
    expect(b2.missing).toBe(true);
    expect(existsSync(board)).toBe(false);
    // --cached 缺失时可区分于「0 未读」
    expect(run(["collab", "board", "--cached"]).status).toBe(3);
  });

  test("过期快照标 stale；未来时间戳不可信", () => {
    run(["collab", "observe", "--once", "--now", now]);
    const board = join(root, "collab", "state", "board.json");
    const raw = JSON.parse(readFileSync(board, "utf8"));
    writeFileSync(board, JSON.stringify({ ...raw, generated_at: "2026-11-09T00:00:00Z" }));
    const st = json(run(["collab", "board", "--json", "--now", now]).stdout);
    expect(st.stale).toBe(true);
    writeFileSync(board, JSON.stringify({ ...raw, generated_at: "2030-01-01T00:00:00Z" }));
    expect(json(run(["collab", "board", "--json", "--now", now]).stdout).missing).toBe(true);
  });

  test("escalations 去重：重复 tick 不重复追加", () => {
    run(["collab", "observe", "--once", "--now", now]);
    run(["collab", "observe", "--once", "--now", now]);
    const lines = readFileSync(join(root, "collab", "escalations.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("无常驻：--watch/--daemon 明确拒绝；observe 仍是一次", () => {
    const r = run(["collab", "observe", "--watch"]);
    expect(r.status).toBe(2);
    expect(r.stderr || r.stdout).toContain("E_NO_DAEMON");
    expect(run(["collab", "observe", "--wath"]).status).toBe(2);
  });

  test("interval 单一来源：显式 300 落盘；board 回退不会把 60 写回", () => {
    run(["collab", "observe", "--interval", "300", "--now", now]);
    const board = join(root, "collab", "state", "board.json");
    expect(JSON.parse(readFileSync(board, "utf8")).interval_s).toBe(300);
    const fs = require("node:fs");
    fs.rmSync(board);
    run(["collab", "board", "--json", "--now", now]); // 内存现算，不写
    expect(existsSync(board)).toBe(false);
  });

  test("观察器不改消息状态", () => {
    const before = readFileSync(join(root, "collab", "inbox", "ses_b", "m-p0.json"), "utf8");
    run(["collab", "observe", "--once", "--now", now]);
    const after = readFileSync(join(root, "collab", "inbox", "ses_b", "m-p0.json"), "utf8");
    expect(after).toBe(before);
  });
});
