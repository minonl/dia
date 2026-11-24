import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// A：升级后必须刷新 $JOB_ROOT/bin/dia-job 副本（install.sh 一次性拷贝，dia update 原来不动它）
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const pkgJob = join(import.meta.dir, "..", "packages", "job", "bin", "dia-job");

function sandbox(withCopy: boolean) {
  const base = mkdtempSync(join(tmpdir(), "dia-copy-"));
  const home = join(base, "home");
  const data = join(base, "data");
  const jobRoot = join(data, "job");
  mkdirSync(join(jobRoot, "bin"), { recursive: true });
  mkdirSync(join(jobRoot, "lib"), { recursive: true });
  mkdirSync(home, { recursive: true });
  if (withCopy) {
    const stale = join(jobRoot, "bin", "dia-job");
    writeFileSync(stale, "#!/bin/bash\n# 旧副本（无 root 子命令）\nexit 0\n");
    chmodSync(stale, 0o755);
  }
  const env = { ...process.env, HOME: home, DIA_ROOT: data, DIA_JOB_ROOT: "", DIA_JOB_NO_LAUNCHD: "1" };
  const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env });
  return { base, home, data, jobRoot, run, copy: join(jobRoot, "bin", "dia-job") };
}

describe("dia postinstall 刷新 dia-job 副本", () => {
  test("副本存在且落后 → 刷新为包内版本（含 root 子命令）", () => {
    const s = sandbox(true);
    const before = readFileSync(s.copy, "utf8");
    expect(before).not.toContain("root)");
    const r = s.run(["postinstall", "--quiet"]);
    expect(r.status).toBe(0);
    const after = readFileSync(s.copy, "utf8");
    expect(after).toBe(readFileSync(pkgJob, "utf8"));
  });

  test("--quiet 下 stdout 为空（npm 安装脚本不得刷屏）", () => {
    const s = sandbox(true);
    const r = s.run(["postinstall", "--quiet"]);
    expect(r.stdout).toBe("");
  });

  test("副本不存在 → 不新建（只维护已有 install.sh 布局）", () => {
    const s = sandbox(false);
    const r = s.run(["postinstall", "--quiet"]);
    expect(r.status).toBe(0);
    expect(existsSync(s.copy)).toBe(false);
  });

  test("非 quiet 时打印刷新提示", () => {
    const s = sandbox(true);
    const r = s.run(["postinstall"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dia-job 副本已刷新");
  });
});
