import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env as Record<string, string>, DIA_ROOT: root, DIA_SESSION_ID: "ses_t", OPENCODE_SESSION_ID: "" },
});
const json = (s: string) => JSON.parse(s);

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "dia-graph-")); });

describe("dia task 扩展 + graph", () => {
  test("task add 支持 owner/deps/touches，done 仍要求 judge+evidence", () => {
    const a = json(run(["task", "add", "A", "--owner", "ses_t", "--touches", "README.md", "--judge", "true", "--json"]).stdout);
    expect(a.owner).toBe("ses_t");
    expect(a.touches).toEqual(["README.md"]);
    const b = json(run(["task", "add", "B", "--depends", a.id, "--json"]).stdout);
    expect(b.deps).toEqual([a.id]);
    const bad = run(["task", "done", a.id]);
    expect(bad.status).toBe(30);
    const ok = json(run(["task", "done", a.id, "--evidence", "ok", "--reason", "done", "--json"]).stdout);
    expect(ok.status).toBe("done");
    expect(ok.closure_reason).toBe("done");
  });

  test("task link 支持 remove-depends", () => {
    const a = json(run(["task", "add", "link-a", "--json"]).stdout);
    const b = json(run(["task", "add", "link-b", "--json"]).stdout);
    run(["task", "link", a.id, "--depends", b.id]);
    expect(json(run(["task", "list", "--json"]).stdout).find((t: any) => t.id === a.id).deps).toEqual([b.id]);
    run(["task", "link", a.id, "--remove-depends", b.id]);
    expect(json(run(["task", "list", "--json"]).stdout).find((t: any) => t.id === a.id).deps).toEqual([]);
  });

  test("graph 输出 declared 节点/边，环 exit 3，JSON 稳定", () => {
    const a = json(run(["task", "add", "cycle-a", "--json"]).stdout);
    const b = json(run(["task", "add", "cycle-b", "--json"]).stdout);
    run(["task", "link", a.id, "--depends", b.id]);
    run(["task", "link", b.id, "--depends", a.id]);
    const r1 = run(["graph", "--json"]);
    expect(r1.status).toBe(3);
    const g1 = json(r1.stdout);
    expect(g1.cycles.length).toBeGreaterThan(0);
    expect(g1.edges.some((e: any) => e.kind === "depends_on" && e.source === "declared")).toBe(true);
    const r2 = run(["graph", "--json"]);
    expect(r2.stdout).toBe(r1.stdout);
  });

  test("旧 ledger（无 owner/deps/touches）仍可读，字段为 []", () => {
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks", "ledger.jsonl"), JSON.stringify({ ts: "2026-11-05T00:00:00Z", event: "add", id: "t-old", title: "old", role: "builder" }) + "\n");
    const t = json(run(["task", "list", "--json"]).stdout).find((x: any) => x.id === "t-old");
    expect(t).toBeTruthy();
    expect(t.deps).toEqual([]);
    expect(t.touches).toEqual([]);
  });
});
