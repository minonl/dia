import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

function runJob(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["src/cli.ts", "job", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("dia job routing", () => {
  test("forwards argv to DIA_JOB_BIN", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-job-cli-"));
    const bin = join(dir, "stub");
    writeFileSync(bin, "#!/bin/sh\necho \"JOB:$*\"\n");
    chmodSync(bin, 0o755);
    const r = runJob(["ping", "x"], { DIA_JOB_BIN: bin, HOME: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("JOB:ping x");
  });

  test("explicit DIA_JOB_BIN must exist (no silent fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-job-cli-bad-"));
    const r = runJob(["platform"], { HOME: dir, DIA_JOB_BIN: join(dir, "nope") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DIA_JOB_BIN 不存在");
  });

  test("finds workspace package without env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-job-cli-empty-"));
    const r = runJob(["platform"], { HOME: dir, DIA_JOB_BIN: "" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("macos");
  });
});
