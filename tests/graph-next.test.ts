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
const add = (title: string, extra: string[] = []) => json(run(["task", "add", title, ...extra, "--json"]).stdout).id;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-next-")); });

describe("dia graph --next / --explain / --lint", () => {
  test("被 P0 依赖的上游排第一，并标注继承来源", () => {
    const a = add("上游", ["--prio", "P3"]);
    const b = add("下游", ["--prio", "P0", "--depends", a]);
    const r = run(["graph", "--next", "--json"]);
    expect(r.status).toBe(0);
    const items = json(r.stdout).items;
    expect(items[0].id).toBe(a);
    expect(items[0].eff).toBe("P0");
    expect(items[0].inherited).toBe(true);
    expect(items[0].critical).toBe(true);

    const ex = json(run(["graph", "--explain", a, "--json"]).stdout);
    expect(ex.source).toEqual({ id: b, declared: "P0", distance: 1 });
    expect(ex.declared).toBe("P3");
    expect(ex.rank).toBe(1);
  });

  test("doing 置顶；blocked 不进入 next", () => {
    const doing = add("进行中", ["--prio", "P2"]);
    run(["task", "status", doing, "doing"]);
    const blocked = add("阻塞", ["--prio", "P0"]);
    run(["task", "status", blocked, "blocked"]);
    const todo = add("待办", ["--prio", "P1"]);
    const items = json(run(["graph", "--next", "--json"]).stdout).items;
    expect(items[0].id).toBe(doing);
    expect(items.some((x: any) => x.id === blocked)).toBe(false);
    expect(items.some((x: any) => x.id === todo)).toBe(true);
  });

  test("split 后切片先于父；slice 切片排在同级前面", () => {
    const p = add("大任务", ["--prio", "P0"]);
    run(["task", "split", p, "--into", "完整实现,最小可用", "--slice", "最小可用"]);
    const g = json(run(["graph", "--json"]).stdout);
    const by = (id: string) => g.nodes.find((n: any) => n.id === `task:${id}`);
    const kids = by(p).split_children;
    for (const k of kids) expect(by(k).rank).toBeLessThan(by(p).rank);
    const slice = kids.find((k: string) => by(k).slice);
    const other = kids.find((k: string) => k !== slice);
    expect(by(slice).rank).toBeLessThan(by(other).rank);
    expect(by(p).startable).toBe(false);
  });

  test("--lint：dangling / dropped 释放 / 长链，advisory exit 0", () => {
    add("悬空", ["--depends", "t-not-exist"]);
    const d = add("被放弃", ["--prio", "P2"]);
    run(["task", "status", d, "dropped"]);
    add("下游", ["--depends", d]);
    let a = add("链0");
    for (let i = 1; i <= 3; i++) a = add(`链${i}`, ["--depends", a]);
    const p0 = add("链尾P0", ["--prio", "P0", "--depends", a]);
    const r = run(["graph", "--lint", "--json"]);
    expect(r.status).toBe(0);
    const f = json(r.stdout).findings;
    expect(f.some((x: any) => x.kind === "dangling_dep")).toBe(true);
    expect(f.some((x: any) => x.kind === "released_by_drop")).toBe(true);
    expect(f.some((x: any) => x.kind === "long_chain" && x.id === p0)).toBe(true);
  });

  test("有环时 --next/--lint exit 3", () => {
    const a = add("环A"), b = add("环B");
    run(["task", "link", a, "--depends", b]);
    run(["task", "link", b, "--depends", a]);
    expect(run(["graph", "--lint"]).status).toBe(3);
    expect(run(["graph", "--next"]).status).toBe(3);
  });

  test("graph --json 保持确定性（含派生字段）", () => {
    const a = add("稳定上游", ["--prio", "P3"]);
    add("稳定下游", ["--prio", "P0", "--depends", a]);
    expect(run(["graph", "--json"]).stdout).toBe(run(["graph", "--json"]).stdout);
  });
});
