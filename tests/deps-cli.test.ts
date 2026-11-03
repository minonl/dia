import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8" });

describe("dia deps", () => {
  test("record 追加一行；list 派生实测视图", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-deps-cli-"));
    const file = join(dir, "docs", "deps.jsonl");

    const r1 = run(["deps", "record", "--id", "host_cli:foo@1.0.0", "--kind", "host_cli",
      "--version", "1.0.0", "--role", "optional", "--file", file]);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("recorded");
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(line.method).toBe("manual");

    const r2 = run(["deps", "list", "--file", file, "--json"]);
    expect(r2.status).toBe(0);
    const rows = JSON.parse(r2.stdout);
    expect(rows.length).toBe(1);
    expect(rows[0].check.status).toBe("ok"); // 可选依赖缺失 → ok + note
    expect(rows[0].check.note).toBe(true);
  });

  test("required 缺失 → list 退出 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-deps-cli-"));
    const file = join(dir, "deps.jsonl");
    expect(run(["deps", "record", "--id", "host_cli:definitely-not-real-xyz@1.0.0",
      "--kind", "host_cli", "--version", "1.0.0", "--role", "required", "--file", file]).status).toBe(0);
    const r = run(["deps", "list", "--file", file]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("definitely-not-real-xyz");
  });

  test("缺参数 → 用法错误 2", () => {
    expect(run(["deps", "record", "--kind", "npm"]).status).toBe(2);
  });
});
