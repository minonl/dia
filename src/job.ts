import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
export const legacyJobRoot = () => join(paths.xdgData(), "dia-job");
/** 旧版（XDG 之前）的 job 根：老机器上可能还在这里，迁移期一并认。 */
export const ancientJobRoot = () => join(homedir(), ".local", "share", "dia-job");
/** 所有旧根（只读兼容）：XDG 口径在前，历史固定路径在后。 */
export const legacyJobRoots = () => [...new Set([legacyJobRoot(), ancientJobRoot()])];

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

export type JobRootSource = "env" | "pin" | "legacy" | "next";

/** 落钉文件：一旦存在，根就固定在新根，**永不回退 legacy**（迁移完成后由 `job install`/`migrate` 写入）。 */
export const jobPinFile = () => join(paths.jobRoot(), ".rootpin");

export function readJobPin(): { root: string; at?: string } | null {
  try {
    const d = JSON.parse(readFileSync(jobPinFile(), "utf8"));
    return d?.root ? { root: String(d.root), at: d.at } : null;
  } catch { return null; }
}

/** 落钉（幂等）：记录当前权威根；临时根不落钉。 */
export function pinJobRoot(root = paths.jobRoot()): void {
  // 沙箱根默认不落钉；显式指定了根（测试/多 profile）或 escape hatch 才写
  const explicit = Boolean(process.env.DIA_ROOT || process.env.DIA_DATA_DIR || process.env.DIA_JOB_ROOT);
  if (isEphemeralPath(root) && !explicit && process.env.DIA_JOB_ALLOW_EPHEMERAL !== "1") return;
  try {
    mkdirSync(dirname(jobPinFile()), { recursive: true });
    writeFileSync(jobPinFile(), JSON.stringify({ root: resolve(root), at: new Date().toISOString() }, null, 1) + "\n");
  } catch { /* 落钉失败不影响主流程（doctor 会提示） */ }
}
/** 根来源：env 显式 > legacy 兼容 > 新根。沙箱（临时数据根/HOME）**永不回退 legacy**。 */
export function jobRootSource(): JobRootSource {
  if (process.env.DIA_JOB_ROOT) return "env";
  const next = paths.jobRoot();
  if (readJobPin()) return "pin"; // 已落钉：固定新根，永不回退 legacy
  if (isEphemeralPath(dataRootPath()) || isEphemeralPath(homedir())) return "next";
  return !existsSync(next) && legacyJobRoots().some((p) => existsSync(p)) ? "legacy" : "next";
}

export function jobRootResolved(): string {
  if (process.env.DIA_JOB_ROOT) return process.env.DIA_JOB_ROOT;
  // 落钉优先（与 bash `_resolve_job_root` 的 ② 对齐）：pin 指向的根**存在**才采用；
  // 指向已删除目录时静默回落（不抛），否则老机器会整体失效。
  // 为什么必须读 pin.root：`dia job` 委派时把 `jobRootResolved()` 当 DIA_JOB_ROOT 传给 bash，
  // 不读 pin 就会用错值反向覆盖 bash 里正确的 pin（#239 残留 → 真 split-brain）。
  const pin = readJobPin();
  if (pin && existsSync(pin.root)) return pin.root;
  if (jobRootSource() !== "legacy") return paths.jobRoot();
  return legacyJobRoots().find((p) => existsSync(p)) ?? legacyJobRoot();
}

/** 写入门控：临时根 / legacy 根一律拒绝（测试用 DIA_JOB_NO_LAUNCHD=1 或 DIA_JOB_ALLOW_EPHEMERAL=1 放行）。 */
export function assertWritableJobRoot(root = jobRootResolved()): void {
  if (process.env.DIA_JOB_ALLOW_EPHEMERAL === "1") return;
  const pin = readJobPin();
  if (pin && process.env.DIA_JOB_ROOT && resolve(root) !== resolve(pin.root)) {
    throw new Error(`E_JOB_ROOT_PINNED: 已落钉到 ${pin.root}，拒绝写入 ${root}（确需切换：删 ${jobPinFile()} 或 DIA_JOB_ALLOW_EPHEMERAL=1）`);
  }
  if (legacyJobRoots().some((p) => resolve(p) === resolve(root))) {
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
  // 首次成功写入即落钉：之后即使旧根还在，也不会再被 legacy fallback 抢走
  if ((r.status ?? 1) === 0 && argv[0] === "install") pinJobRoot(opts.root || jobRootResolved());
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


/**
 * 升级后刷新 `$JOB_ROOT/{bin,lib}` 下的 dia-job 副本（install.sh 布局的后续维护）。
 *
 * 为什么需要：副本由 `packages/job/install.sh` 一次性拷进去，
 * 而 `dia update` / `dia postinstall` 都不会动它 → 升级后**裸跑 `dia-job` 仍是旧逻辑**
 * （#231/#239 的修复对裸跑用户不生效，且与 `dia job` 的包内副本行为不一致）。
 *
 * 约束：只在副本**已存在**时覆盖（不新建副本、不碰 `~/.local/bin` 软链、不碰 legacy 根）；
 * 内容相同则跳过；失败静默（doctor 的 job.copy 会提示）。
 */
export function refreshJobCopy(): { path: string; updated: boolean; reason?: string } | null {
  const root = jobRootResolved();
  const target = join(root, "bin", "dia-job");
  if (!existsSync(target)) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = [
    join(here, "..", "packages", "job"),       // dist/cli.js
    join(here, "..", "..", "packages", "job"), // src/job.ts（repo / 测试）
  ].find((p) => existsSync(join(p, "bin", "dia-job")));
  if (!pkg) return { path: target, updated: false, reason: "包内副本未找到" };
  let updated = false;
  for (const rel of ["bin/dia-job", "lib/config.sh", "lib/policy.sh", "lib/json.mjs"]) {
    const src = join(pkg, rel);
    const dst = join(root, rel);
    try {
      const a = readFileSync(src);
      const b = existsSync(dst) ? readFileSync(dst) : null;
      if (b && a.equals(b)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, a);
      updated = true;
    } catch { /* 单个文件失败不影响其它 */ }
  }
  if (updated) { try { chmodSync(target, 0o755); } catch { /* ignore */ } }
  return { path: target, updated };
}
