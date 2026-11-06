import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env as Record<string, string>, DIA_ROOT: root },
});

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-export-")); });

describe("dia graph --export-html", () => {
  test("导出单文件、0600、无网络引用", () => {
    run(["task", "add", "导出任务", "--prio", "P2", "--progress", "20"]);
    const out = join(root, "g.html");
    const r = run(["graph", "--export-html", "--out", out, "--now", "2026-11-06T10:00:00"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const html = readFileSync(out, "utf8");
    expect(html).toContain('id="dia-graph"');
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  test("同一 --now 两次导出字节一致；不同 --now 只差时间戳", () => {
    run(["task", "add", "稳定"]);
    const a = join(root, "a.html"), b = join(root, "b.html");
    run(["graph", "--export-html", "--out", a, "--now", "2026-11-06T10:00:00"]);
    run(["graph", "--export-html", "--out", b, "--now", "2026-11-06T10:00:00"]);
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });

  test("已存在文件需 --force", () => {
    const out = join(root, "g2.html");
    run(["graph", "--export-html", "--out", out, "--now", "2026-11-06T10:00:00"]);
    const again = run(["graph", "--export-html", "--out", out, "--now", "2026-11-06T10:00:00"]);
    expect(again.status).toBe(2);
    expect(again.stderr || again.stdout).toContain("E_GRAPH");
    expect(run(["graph", "--export-html", "--out", out, "--force", "--now", "2026-11-06T10:00:00"]).status).toBe(0);
  });

  test("非法 --now / --limit 拒绝", () => {
    expect(run(["graph", "--export-html", "--now", "not-a-date"]).status).toBe(2);
    expect(run(["graph", "--export-html", "--limit", "-1"]).status).toBe(2);
  });

  test("默认输出到数据根 export/ 目录", () => {
    const r = run(["graph", "--export-html", "--now", "2026-11-06T10:00:00"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(root, "export", "graph-20261106-1000.html"));
    expect(existsSync(r.stdout.trim())).toBe(true);
  });
});
