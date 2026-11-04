import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = join(import.meta.dir, "..", "scripts", "pr-merge.sh");
let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "dia-ghbin-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "pr checks")
    if [ "$FAKE_CHECKS" = "fail" ]; then
      echo '[{"name":"test (ubuntu-latest)","bucket":"fail","state":"FAILURE"},{"name":"test (macos-latest)","bucket":"pass","state":"SUCCESS"}]'
    else
      echo '[{"name":"test (ubuntu-latest)","bucket":"pass","state":"SUCCESS"},{"name":"test (macos-latest)","bucket":"pass","state":"SUCCESS"}]'
    fi ;;
  "pr merge") echo "merged $3" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
});

const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bash", [script, ...args], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: "o/r", ...env },
});

describe("pr-merge gate", () => {
  test("CI 全绿 → dry-run 放行", () => {
    const r = run(["1", "--dry-run"], { FAKE_CHECKS: "pass" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("checks ok");
  });

  test("有失败检查 → 拒绝（exit 1，不调 merge）", () => {
    const r = run(["1", "--dry-run"], { FAKE_CHECKS: "fail" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("test (ubuntu-latest)");
  });
});
