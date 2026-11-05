import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("docs index", () => {
  test("docs/index.md、llms.txt 与 docs/**.md 同步（llms-full.txt 本地生成、不入库）", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "scripts", "docs-index.mjs"), "--check"], { encoding: "utf8" });
    if (r.status !== 0) console.error(r.stderr || r.stdout);
    expect(r.status).toBe(0);
  });
});
