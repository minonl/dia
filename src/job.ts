import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as paths from "./paths.ts";

/** Locate the job package binary: explicit env > repo workspace > global install. */
export function jobBin(): { bin: string | null; error?: string } {
  const env = process.env.DIA_JOB_BIN;
  if (env) {
    const abs = resolve(env);
    return existsSync(abs) ? { bin: abs } : { bin: null, error: `DIA_JOB_BIN 不存在：${abs}` };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "packages", "job", "bin", "dia-job"),
    join(here, "..", "..", "packages", "job", "bin", "dia-job"),
    join(homedir(), ".local", "bin", "dia-job"),
  ];
  const found = candidates.find((p) => existsSync(p));
  return found ? { bin: found } : { bin: null };
}

/** dia-job 数据根（唯一事实源 = dia 数据根下的 job/）
 *  · 显式 DIA_JOB_ROOT 优先（逃生口 / 测试）
 *  · 迁移期兼容：新根不存在、旧根（~/.local/share/dia-job）存在 → 用旧根（否则升级瞬间定时任务全找不到）
 *  · 都没有 → 新根 ~/.dia/job（dia-job 自己会创建）
 */
export function jobRootResolved(): string {
  if (process.env.DIA_JOB_ROOT) return process.env.DIA_JOB_ROOT;
  const next = paths.jobRoot();
  const legacy = join(homedir(), ".local", "share", "dia-job");
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
}

/** 捕获式执行（供 `dia job status` 追列：health 列必须读缓存、零执行）。 */
export function runJobCapture(argv: string[]): { status: number; stdout: string; stderr: string } {
  const { bin, error } = jobBin();
  if (!bin) {
    process.stderr.write(`dia job: ${error || "未找到 dia-job；npm 包不完整？`npm i -g @minonl/dia@latest` 重装；或设置 DIA_JOB_BIN"}\n`);
    return { status: 2, stdout: "", stderr: "" };
  }
  const r = spawnSync(bin, argv, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, DIA_JOB_ROOT: jobRootResolved() },
  });
  if (r.error) {
    process.stderr.write(`dia job: ${r.error.message}\n`);
    return { status: 1, stdout: "", stderr: "" };
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function runJob(argv: string[]): number {
  const { bin, error } = jobBin();
  if (!bin) {
    process.stderr.write(`dia job: ${error || "未找到 dia-job；npm 包不完整？`npm i -g @minonl/dia@latest` 重装；或设置 DIA_JOB_BIN"}\n`);
    return 2;
  }
  // 把 dia 的数据根传下去：dia-job 默认仍按 XDG 推导，不传会与 ~/.dia 分叉
  const r = spawnSync(bin, argv, { stdio: "inherit", env: { ...process.env, DIA_JOB_ROOT: jobRootResolved() } });
  if (r.error) {
    process.stderr.write(`dia job: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}
