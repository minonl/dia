import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function runJob(argv: string[]): number {
  const { bin, error } = jobBin();
  if (!bin) {
    process.stderr.write(`dia job: ${error || "未找到 dia-job；先跑 packages/job/install.sh 或设置 DIA_JOB_BIN"}\n`);
    return 2;
  }
  const r = spawnSync(bin, argv, { stdio: "inherit" });
  if (r.error) {
    process.stderr.write(`dia job: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}
