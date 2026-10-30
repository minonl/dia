import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

function cli(args: string[]) {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: root, encoding: "utf8" });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dia-kb-cli-"));
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "index.md"), "# 索引\n\n- [规则一](rules/a.md)\n");
  writeFileSync(join(dir, "rules/a.md"), "---\nreview_by: 2020-01-01\n---\n# 规则一\n\n知识库预算 token 压力。\n");
  writeFileSync(join(dir, "rules/b.md"), "# 规则二\n\n会话采集与脱敏。\n");
  const db = join(dir, ".idx.db");
  const r = cli(["kb", "index", "--root", dir, "--db", db]);
  expect(r.status).toBe(0);
  return { dir, db };
}

describe("kb query/review CLI", () => {
  test("query alias + json + full + bytes", () => {
    const { dir, db } = fixture();
    const r = cli(["kb", "query", "知识库预算", "--root", dir, "--db", db, "--json", "--full", "--bytes"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows[0].path).toBe("rules/a.md");
    expect(rows[0].text).toContain("知识库预算");
    expect(rows[0].bytes).toBeGreaterThan(0);
  });

  test("missing index exits 3 with explicit message", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-kb-cli-noidx-"));
    writeFileSync(join(dir, "a.md"), "# A\n");
    const r = cli(["kb", "query", "A", "--root", dir, "--db", join(dir, ".idx.db")]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("index missing");
  });

  test("--auto-index rebuilds a missing index", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-kb-auto-"));
    writeFileSync(join(dir, "a.md"), "# A\n\n知识库预算。\n");
    const db = join(dir, ".idx.db");
    const r = cli(["kb", "query", "知识库", "--root", dir, "--db", db, "--auto-index", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).length).toBeGreaterThan(0);
  });

  test("rejects non-positive limit", () => {
    const { dir, db } = fixture();
    const r = cli(["kb", "query", "知识库", "--root", dir, "--db", db, "--limit", "abc"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("positive integer");
  });

  test("review reports missing and overdue", () => {
    const { dir, db } = fixture();
    const r = cli(["kb", "review", "--root", dir, "--db", db, "--json"]);
    expect(r.status).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.missing).toContain("rules/b.md");
    expect(data.overdue[0].path).toBe("rules/a.md");
  });
});
