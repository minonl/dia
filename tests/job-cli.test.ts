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

describe("dia job 数据根跟随 ~/.dia", () => {
  function stub(dir: string) {
    const bin = join(dir, "stub");
    writeFileSync(bin, "#!/bin/sh\necho \"ROOT:$DIA_JOB_ROOT\"\n");
    chmodSync(bin, 0o755);
    return bin;
  }
  test("新根存在 → 用 ~/.dia/job", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-job-root-new-"));
    spawnSync("mkdir", ["-p", join(home, ".dia", "job")]);
    // DIA_ROOT / DIA_DATA_DIR 可能被其它测试文件污染（bun test 同进程），显式清空
    const r = runJob(["x"], { HOME: home, DIA_JOB_BIN: stub(home), DIA_ROOT: "", DIA_DATA_DIR: "" });
    expect(r.stdout.trim()).toBe(`ROOT:${join(home, ".dia", "job")}`);
  });
  test("迁移期：新根不存在、旧根存在 → 回退旧根", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-job-root-old-"));
    spawnSync("mkdir", ["-p", join(home, ".local", "share", "dia-job")]);
    // DIA_ROOT / DIA_DATA_DIR 可能被其它测试文件污染（bun test 同进程），显式清空
    const r = runJob(["x"], { HOME: home, DIA_JOB_BIN: stub(home), DIA_ROOT: "", DIA_DATA_DIR: "" });
    expect(r.stdout.trim()).toBe(`ROOT:${join(home, ".local", "share", "dia-job")}`);
  });
  test("都没有 → 默认 ~/.dia/job", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-job-root-none-"));
    // DIA_ROOT / DIA_DATA_DIR 可能被其它测试文件污染（bun test 同进程），显式清空
    const r = runJob(["x"], { HOME: home, DIA_JOB_BIN: stub(home), DIA_ROOT: "", DIA_DATA_DIR: "" });
    expect(r.stdout.trim()).toBe(`ROOT:${join(home, ".dia", "job")}`);
  });
  test("显式 DIA_JOB_ROOT 优先", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-job-root-env-"));
    const r = runJob(["x"], { HOME: home, DIA_JOB_BIN: stub(home), DIA_JOB_ROOT: "/tmp/explicit-job", DIA_ROOT: "" });
    expect(r.stdout.trim()).toBe("ROOT:/tmp/explicit-job");
  });
});
