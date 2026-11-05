import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("docs links", () => {
  test("docs/ 内相对链接都存在且不越出 docs/", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "scripts", "docs-link-check.mjs")], { encoding: "utf8" });
    if (r.status !== 0) console.error(r.stderr || r.stdout);
    expect(r.status).toBe(0);
  });
});
