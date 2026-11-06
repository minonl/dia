import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-plan-")); });

describe("dia task plan（计划态字段）", () => {
  test("add 直接带 prio/start/due/progress", () => {
    const r = run(["task", "add", "实现 A", "--prio", "p1", "--start", "2026-11-01", "--due", "2026-11-10", "--progress", "40", "--json"]);
    expect(r.status).toBe(0);
    const t = json(r.stdout);
    expect(t.prio).toBe("P1");
    expect(t.start).toBe("2026-11-01");
    expect(t.due).toBe("2026-11-10");
    expect(t.progress).toBe(40);
    expect(t.status).toBe("todo");
  });

  test("plan 只覆盖出现的字段", () => {
    const add = json(run(["task", "add", "B", "--prio", "P2", "--start", "2026-11-02", "--progress", "10", "--json"]).stdout);
    const r = run(["task", "plan", add.id, "--progress", "60", "--json"]);
    expect(r.status).toBe(0);
    const t = json(r.stdout);
    expect(t.prio).toBe("P2");
    expect(t.start).toBe("2026-11-02");
    expect(t.progress).toBe(60);
    expect(t.status).toBe("todo");
    // 只追加一行 plan 事件，不产生 status 事件
    const lines = readFileSync(join(root, "tasks", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((e: any) => e.event === "plan").length).toBe(1);
    expect(lines.filter((e: any) => e.event === "status").length).toBe(0);
  });

  test("非法值 exit 30 且不落账", () => {
    const add = json(run(["task", "add", "C", "--json"]).stdout);
    for (const bad of [["--prio", "X1"], ["--start", "2026-13-01"], ["--progress", "140"], ["--progress", "1.5"]]) {
      const r = run(["task", "plan", add.id, ...bad, "--json"]);
      expect(r.status).toBe(30);
      expect(r.stderr || r.stdout).toContain("E_TASK");
    }
    const t = json(run(["task", "list", "--json"]).stdout).find((x: any) => x.id === add.id);
    expect(t.prio).toBeUndefined();
    expect(t.progress).toBeUndefined();
  });

  test("start 晚于 due 被拒（含与已有字段合并后）", () => {
    const add = json(run(["task", "add", "D", "--start", "2026-11-05", "--json"]).stdout);
    expect(run(["task", "plan", add.id, "--due", "2026-11-01"]).status).toBe(30);
  });

  test("done/accepted 派生 closed_at，回到进行态清除", () => {
    const add = json(run(["task", "add", "E", "--judge", "true", "--json"]).stdout);
    expect(json(run(["task", "done", add.id, "--evidence", "ok", "--json"]).stdout).closed_at).toBeTruthy();
    expect(json(run(["task", "status", add.id, "doing", "--json"]).stdout).closed_at).toBeUndefined();
  });

  test("旧账本（无计划字段/坏值）仍可读且不抛错", () => {
    mkdirSync(join(root, "tasks"), { recursive: true });
    const ts = "2026-10-01T00:00:00.000Z";
    writeFileSync(join(root, "tasks", "ledger.jsonl"), [
      JSON.stringify({ ts, event: "add", id: "t-old1", title: "旧任务", role: "builder", judge: "", deps: [], touches: [] }),
      JSON.stringify({ ts, event: "plan", id: "t-old1", prio: "bad", start: "nope", progress: 999 }),
    ].join("\n") + "\n");
    const rows = json(run(["task", "list", "--json"]).stdout);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("旧任务");
    expect(rows[0].prio).toBeUndefined();
    expect(rows[0].start).toBeUndefined();
    expect(rows[0].progress).toBeUndefined();
    expect(rows[0].status).toBe("todo");
  });
});
