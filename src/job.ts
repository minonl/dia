import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
export const legacyJobRoot = () => join(homedir(), ".local", "share", "dia-job");

/** 临时路径（测试/沙箱）：这类根永远不许落到 legacy，也不许注册真定时。 */
export function isEphemeralPath(p: string): boolean {
  const real = (() => { try { return realpathSync(p); } catch { return resolve(p); } })();
  const pre = [tmpdir(), "/tmp", "/var/folders", "/private/var/folders", "/run/user", "/dev/shm"];
  return pre.some((r) => {
    const rr = (() => { try { return realpathSync(r); } catch { return r; } })();
    return real === rr || real.startsWith(rr + sep);
  });
}

/** 数据根（DIA_ROOT > DIA_HOME > ~/.dia）：用于判断当前是否沙箱运行。 */
export function dataRootPath(): string {
  return process.env.DIA_ROOT || process.env.DIA_HOME || join(homedir(), ".dia");
}

export type JobRootSource = "env" | "legacy" | "next";
/** 根来源：env 显式 > legacy 兼容 > 新根。沙箱（临时数据根/HOME）**永不回退 legacy**。 */
export function jobRootSource(): JobRootSource {
  if (process.env.DIA_JOB_ROOT) return "env";
  const next = paths.jobRoot();
  if (isEphemeralPath(dataRootPath()) || isEphemeralPath(homedir())) return "next";
  return !existsSync(next) && existsSync(legacyJobRoot()) ? "legacy" : "next";
}

export function jobRootResolved(): string {
  if (process.env.DIA_JOB_ROOT) return process.env.DIA_JOB_ROOT;
  return jobRootSource() === "legacy" ? legacyJobRoot() : paths.jobRoot();
}

/** 写入门控：临时根 / legacy 根一律拒绝（测试用 DIA_JOB_NO_LAUNCHD=1 或 DIA_JOB_ALLOW_EPHEMERAL=1 放行）。 */
export function assertWritableJobRoot(root = jobRootResolved()): void {
  if (process.env.DIA_JOB_ALLOW_EPHEMERAL === "1") return;
  if (resolve(root) === resolve(legacyJobRoot())) {
    throw new Error(`E_JOB_ROOT_LEGACY: 当前解析到旧 job 根 ${root}（只读兼容）；修复：dia job migrate --from ${root}`);
  }
  if (!process.env.DIA_JOB_ROOT && isEphemeralPath(root) && process.env.DIA_JOB_NO_LAUNCHD !== "1") {
    throw new Error(`E_JOB_ROOT_EPHEMERAL: ${root} 在临时目录，拒绝注册真定时（测试用 DIA_JOB_NO_LAUNCHD=1，或显式 DIA_JOB_ALLOW_EPHEMERAL=1）`);
  }
}

/** 捕获式执行（供 `dia job status` 追列：health 列必须读缓存、零执行）。 */
export function runJobCapture(argv: string[], opts: { root?: string } = {}): { status: number; stdout: string; stderr: string } {
  const { bin, error } = jobBin();
  if (!bin) {
    process.stderr.write(`dia job: ${error || "未找到 dia-job；npm 包不完整？`npm i -g @minonl/dia@latest` 重装；或设置 DIA_JOB_BIN"}\n`);
    return { status: 2, stdout: "", stderr: "" };
  }
  const r = spawnSync(bin, argv, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, DIA_JOB_ROOT: opts.root || jobRootResolved() },
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
