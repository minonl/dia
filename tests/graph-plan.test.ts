import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { render } from "../src/graph-tui.ts";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env as Record<string, string>, DIA_ROOT: root, DIA_SESSION_ID: "ses_g", OPENCODE_SESSION_ID: "" },
});
const json = (s: string) => JSON.parse(s);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-graph-plan-")); });

describe("graph 计划字段（schema 1 additive）", () => {
  test("节点带 prio/start/due/progress/时间戳，旧字段不变", () => {
    const t = json(run(["task", "add", "计划任务", "--prio", "P1", "--start", "2026-11-01", "--due", "2026-11-08", "--progress", "30", "--touches", "src/a.ts", "--json"]).stdout);
    const g = json(run(["graph", "--json"]).stdout);
    expect(g.schema).toBe(1);
    expect(g.capabilities).toEqual(["prio", "timeline", "progress", "eff-prio", "ready", "rank", "split"]);
    expect(g.ranking).toEqual({ policy: "kahn-v1" });
    const n = g.nodes.find((x: any) => x.id === `task:${t.id}`);
    expect(n.prio).toBe("P1");
    expect(n.start).toBe("2026-11-01");
    expect(n.due).toBe("2026-11-08");
    expect(n.progress).toBe(30);
    expect(n.progress_derived).toBe(false);
    expect(n.created_at).toBeTruthy();
    expect(n.deps).toEqual([]);
    expect(n.touches).toEqual(["src/a.ts"]);
    expect(n.closed_at).toBeUndefined();
  });

  test("缺计划字段时进度按状态派生并标记 estimated；不输出 null", () => {
    const t = json(run(["task", "add", "旧式任务", "--json"]).stdout);
    const g = json(run(["graph", "--json"]).stdout);
    const n = g.nodes.find((x: any) => x.id === `task:${t.id}`);
    expect(n.progress).toBe(0);
    expect(n.progress_derived).toBe(true);
    expect(n.prio).toBeUndefined();
    expect(n.start).toBeUndefined();
    expect(JSON.stringify(n)).not.toContain("null");
  });

  test("done 后节点带 closed_at", () => {
    const t = json(run(["task", "add", "完成任务", "--judge", "true", "--json"]).stdout);
    run(["task", "done", t.id, "--evidence", "ok"]);
    const g = json(run(["graph", "--json"]).stdout);
    expect(g.nodes.find((x: any) => x.id === `task:${t.id}`).closed_at).toBeTruthy();
  });

  test("graph 输出仍确定性（两次字节相等）", () => {
    run(["task", "add", "稳定", "--prio", "P2"]);
    const a = run(["graph", "--json"]).stdout;
    const b = run(["graph", "--json"]).stdout;
    expect(b).toBe(a);
  });

  test("fixture graph.v1.json 可被 TUI 渲染（旧读者容忍新字段）", () => {
    const g = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "graph.v1.json"), "utf8"));
    const s = render(g, { color: false });
    expect(s).toContain("fixture 任务");
    expect(s).toContain("↳ depends fixture 依赖");
  });

  test("--task 过滤保留计划字段", () => {
    const a = json(run(["task", "add", "A", "--prio", "P0", "--json"]).stdout);
    const b = json(run(["task", "add", "B", "--depends", a.id, "--json"]).stdout);
    const g = json(run(["graph", "--task", b.id, "--json"]).stdout);
    const n = g.nodes.find((x: any) => x.id === `task:${a.id}`);
    expect(n.prio).toBe("P0");
  });

  test("空账本输出空图 + capabilities", () => {
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks", "ledger.jsonl"), "");
    const g = json(run(["graph", "--json"]).stdout);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.capabilities).toBeTruthy();
  });
});
