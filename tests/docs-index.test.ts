import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("docs index", () => {
  test("docs/index.md、llms.txt、llms-full.txt 与 docs/**.md 同步", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "scripts", "docs-index.mjs"), "--check"], { encoding: "utf8" });
    if (r.status !== 0) console.error(r.stderr || r.stdout);
    expect(r.status).toBe(0);
  });
});
