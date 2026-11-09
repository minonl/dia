import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignSeats } from "../src/seats.ts";

const NOW = new Date("2026-11-09T10:00:00Z");
let root: string;
const KEYS = ["DIA_ROOT"] as const;
const saved: Record<string, string | undefined> = {};

const task = (id: string, o: any = {}) => ({
  id, title: id, role: "builder", judge: "", status: "todo", evidence: "",
  deps: [], touches: [], created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
  ...o,
} as any);

function seat(id: string, minutesAgo: number) {
  mkdirSync(join(root, "collab", "sessions"), { recursive: true });
  writeFileSync(join(root, "collab", "sessions", `${id}.json`), JSON.stringify({
    schema: 1, session_id: id, host: "cli", display_name: id, cwd: "/tmp",
    started_at: NOW.toISOString(), last_seen: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    capabilities: ["msg:v2"], address: `session:${id}`,
  }));
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "dia-seats-"));
  process.env.DIA_ROOT = root;
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("seats：固定席位 + 亲和", () => {
  test("两个在线席位各接一件；rank 小的先分；busy 席位不再接", () => {
    seat("ses_a", 1); seat("ses_b", 2);
    const tasks = [
      task("t-1", { prio: "P0", touches: ["src/a.ts"] }),
      task("t-2", { prio: "P1", touches: ["docs/b.md"] }),
      task("t-3", { owner: "ses_a", status: "doing", prio: "P0" }),
    ];
    const r = assignSeats(tasks, { seats: 2, now: NOW });
    expect(r.seats.find((s) => s.seat === "ses_a")!.state).toBe("busy");
    // 两个席位里 ses_a 已 busy → 只能再接 1 件
    expect(r.assignments.length).toBe(1);
    expect(["t-1", "t-2"]).toContain(r.assignments[0].task);
    expect(r.metrics.idle_slots).toBe(0);
  });

  test("同 owner / 同 touches 亲和更高（cost 更低）", () => {
    seat("ses_a", 1); seat("ses_b", 1);
    const tasks = [
      task("t-old", { owner: "ses_a", status: "done", touches: ["src/x/a.ts"], prio: "P2" }),
      task("t-new", { prio: "P1", touches: ["src/x/b.ts"] }),
    ];
    const r = assignSeats(tasks, { seats: 1, now: NOW });
    // 只开 1 个席位时选在线最久新的（ses_a/ses_b 同 last_seen -> 按 id 排，ses_a）
    expect(r.assignments[0].seat).toBe("ses_a");
    expect(r.assignments[0].affinity.module).toBe(1);
    expect(r.assignments[0].affinity.total).toBeGreaterThanOrEqual(1);
  });

  test("离线会话不算席位；没有在线席位 → unassigned seat_offline", () => {
    seat("ses_old", 60);
    const tasks = [task("t-1", { prio: "P0" })];
    const r = assignSeats(tasks, { seats: 2, now: NOW });
    expect(r.seats.length).toBe(0);
    expect(r.unassigned[0].reason).toBe("seat_offline");
  });

  test("确定性：打乱任务顺序结果一致", () => {
    seat("ses_a", 1); seat("ses_b", 2);
    const base = [
      task("t-1", { prio: "P1", touches: ["src/a.ts"] }),
      task("t-2", { prio: "P1", touches: ["src/b.ts"] }),
      task("t-3", { prio: "P2" }),
    ];
    const a = JSON.stringify(assignSeats(base, { seats: 2, now: NOW }));
    const b = JSON.stringify(assignSeats([...base].reverse(), { seats: 2, now: NOW }));
    expect(b).toBe(a);
  });

  test("claim 由离线会话持有时记 conflict（不阻断分配）", () => {
    seat("ses_a", 1);
    mkdirSync(join(root, "collab"), { recursive: true });
    writeFileSync(join(root, "collab", "claims.jsonl"), JSON.stringify({
      event: "claim", id: "c-1", ts: NOW.toISOString(), path: "src/a.ts", scope: "repo", holder: "ses_gone", reason: "x",
      created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    }) + "\n");
    const r = assignSeats([task("t-1", { prio: "P0", touches: ["src/a.ts"] })], { seats: 1, now: NOW });
    expect(r.assignments[0].task).toBe("t-1");
    expect(r.conflicts.some((c) => c.kind === "claim_held_offline")).toBe(true);
  });
});
