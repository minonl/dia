import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const prev = process.env.DIA_ROOT;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-stdout-")); });
afterEach(() => { if (prev === undefined) delete process.env.DIA_ROOT; else process.env.DIA_ROOT = prev; });

describe("CLI 管道输出不被截断", () => {
  test("graph --json >128KB 仍能被管道完整解析", async () => {
    process.env.DIA_ROOT = root;
    const task = await import("../src/task.ts");
    const long = "长任务标题".repeat(50);
    for (let i = 0; i < 500; i++) task.add(`${long}-${i}`, { judge: "x" });

    const r = spawnSync("bun", [cli, "graph", "--json"], {
      encoding: "utf8",
      env: { ...process.env as Record<string, string>, DIA_ROOT: root },
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(r.status).toBe(0);
    // 按字节判定：stdout.length 是 UTF-16 字符数，CJK 每字符 3 字节（Linux CI 曾因此卡在阈值边界）
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeGreaterThan(128 * 1024);
    const g = JSON.parse(r.stdout);
    expect(g.nodes.filter((n: any) => n.kind === "task").length).toBe(500);
  });
});
