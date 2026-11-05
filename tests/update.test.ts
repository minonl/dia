import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "dia-npmbin-"));
  writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "$1 $2 $3" = "view @minonl/dia dist-tags" ]; then
  echo '[{"latest":"9.9.9","next":"9.9.9-beta.1"}]'
  exit 0
fi
echo "install $@"
`);
  chmodSync(join(bin, "npm"), 0o755);
});

const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
});

describe("dia update", () => {
  test("--check 发现新版本（exit 1）并打印 latest/next", () => {
    const r = run(["update", "--check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("latest 9.9.9");
  });

  test("version 从 package.json 读取", () => {
    const r = run(["version"]);
    expect(r.stdout.trim()).toMatch(/^dia \d+\.\d+\.\d+/);
  });
});
