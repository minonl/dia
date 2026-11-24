import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 回归：生成的 plist PATH 必须能解析到 dia（dia 只在 fnm/nvm 下的机器上，定时任务否则找不到 dia）
const script = join(import.meta.dir, "..", "packages", "job", "bin", "dia-job");
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";

function installWithPath(pathPrefix: string, extraEnv: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), "dia-plistpath-"));
  const home = join(base, "home");
  const root = join(base, "job");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    PATH: `${pathPrefix}:/usr/bin:/bin`,
    DIA_JOB_ROOT: root,
    DIA_JOB_NO_LAUNCHD: "",
    ...extraEnv,
  };
  const r = spawnSync(BASH, [script, "install", "t-path", "--cmd", "/bin/true", "--calendar", "09:00", "--allow-unstable", "--desc", "t"], {
    encoding: "utf8",
    env,
  });
  const plist = join(home, "Library", "LaunchAgents", "local.dia-job-t-path.plist");
  // 测试会真的 bootstrap 一个 LaunchAgent（macOS）→ 必须回收，否则会残留
  // `local.dia-job-t-path` 指向临时目录，让真机 doctor 永久报「已加载但未登记」（2026-11-24 实测）。
  installed.push({ env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, plist, home, root, env };
}

const installed: Array<{ env: Record<string, string> }> = [];
afterAll(() => {
  for (const { env } of installed) {
    spawnSync(BASH, [script, "uninstall", "t-path"], { env, encoding: "utf8" });
  }
});

describe("plist PATH 含 dia 目录（E）", () => {
  test("dia 只在自定义目录 → PATH 里带上该目录", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "dia-fakebin-"));
    const fake = join(fakeBin, "dia");
    writeFileSync(fake, "#!/bin/bash\n");
    chmodSync(fake, 0o755);
    const r = installWithPath(fakeBin);
    expect(r.status).toBe(0);
    if (process.platform !== "darwin") return; // plist 只在 macOS 生成
    expect(existsSync(r.plist)).toBe(true);
    const xml = readFileSync(r.plist, "utf8");
    expect(xml).toContain(fakeBin);
  });

  test("DIA_JOB_EXTRA_PATH 会被追加进 PATH", () => {
    const extra = mkdtempSync(join(tmpdir(), "dia-extra-"));
    const r = installWithPath("/usr/bin", { DIA_JOB_EXTRA_PATH: extra });
    expect(r.status).toBe(0);
    if (process.platform !== "darwin") return;
    expect(readFileSync(r.plist, "utf8")).toContain(extra);
  });
});
