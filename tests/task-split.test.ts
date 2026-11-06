import { describe, expect, test, beforeEach } from "bun:test";
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

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-split-")); });

describe("dia task split", () => {
  test("父 depends on 子；子按顺序先于父；judge 继承", () => {
    const p = json(run(["task", "add", "大任务", "--prio", "P0", "--judge", "bun test --grep x", "--json"]).stdout);
    const r = run(["task", "split", p.id, "--into", "切片一,切片二", "--slice", "切片一", "--json"]);
    expect(r.status).toBe(0);
    const parent = json(r.stdout);
    expect(parent.split_children.length).toBe(2);
    expect(parent.deps.sort()).toEqual([...parent.split_children].sort());
    const kids = parent.split_children.map((id: string) => json(run(["task", "list", "--json"]).stdout).find((x: any) => x.id === id));
    expect(kids.every((k: any) => k.split_from === p.id)).toBe(true);
    expect(kids.every((k: any) => k.judge === "bun test --grep x" && k.judge_inherited)).toBe(true);
    expect(kids.filter((k: any) => k.slice).length).toBe(1);

    const g = json(run(["graph", "--json"]).stdout);
    const by = (id: string) => g.nodes.find((n: any) => n.id === `task:${id}`);
    for (const k of parent.split_children) {
      expect(by(k).eff_prio).toBe("P0");        // 继承父的有效优先级
      expect(by(k).rank).toBeLessThan(by(p.id).rank); // 子先于父
      expect(by(k).startable).toBe(true);
    }
    expect(by(p.id).ready).toBe(false); // 父要等两个切片
  });

  test("少于 2 片 / 切片重名 / --slice 不存在 → 拒绝", () => {
    const p = json(run(["task", "add", "要拆", "--json"]).stdout);
    expect(run(["task", "split", p.id, "--into", "只有一个"]).status).toBe(30);
    expect(run(["task", "split", p.id, "--into", "A,A"]).status).toBe(30);
    expect(run(["task", "split", p.id, "--into", "A,B", "--slice", "C"]).status).toBe(30);
  });

  test("doing 需 --force；终态拒绝", () => {
    const p = json(run(["task", "add", "进行中", "--judge", "true", "--json"]).stdout);
    run(["task", "status", p.id, "doing"]);
    expect(run(["task", "split", p.id, "--into", "A,B"]).status).toBe(30);
    expect(run(["task", "split", p.id, "--into", "A,B", "--force"]).status).toBe(0);

    const done = json(run(["task", "add", "已完成", "--judge", "true", "--json"]).stdout);
    run(["task", "done", done.id, "--evidence", "ok"]);
    expect(run(["task", "split", done.id, "--into", "C,D"]).status).toBe(30);
  });
});
