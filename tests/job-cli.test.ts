import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

// 宿主平台期望值（与 dia-job 的 detect_platform 同口径）：
// 原来的断言把 "macos" 写死 ⇒ 在 Linux/WSL 上必然假红（2026-10-30 实测 levm）。
function hostPlatform(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") {
    try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")) ? "wsl" : "linux"; }
    catch { return "linux"; }
  }
  return process.platform;
}

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
    expect(r.stdout.trim()).toBe(hostPlatform());
  });
});
