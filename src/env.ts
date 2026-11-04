// env.ts — 白名单键按需注入子进程（不 source、不长期 export、不回显值）
//
// 为什么在框架里：任何 agent 都要「从纯文本凭据文件取 key 给子进程」，而 key 清单是域的
// （yan 有 LEYAN_*，dabo 有 DABO_*）⇒ 机制进 dia，清单由 persona 声明。
//
// 硬约束（沿用 R37）：
//   · 不 source 环境文件（会灌进该 shell 的每个子进程）
//   · 不做长期 env（只对本次子进程）
//   · 绝不打印值（只打印键名/长度）
//   · 密钥不进 argv（子进程内 export 后 exec，ps 不可见）
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = () => process.env.DIA_HOME || homedir();
const expand = (p: string) => (p === "~" ? home() : p.startsWith("~/") ? join(home(), p.slice(2)) : p);

export interface EnvConfig { files: string[]; keys: string[] }

export function resolveConfig(opts: { files?: string[]; keys?: string[]; persona?: EnvConfig } = {}): EnvConfig {
  const files = (opts.files?.length ? opts.files : opts.persona?.files) ?? [];
  const keys = (opts.keys?.length ? opts.keys : opts.persona?.keys) ?? [];
  return { files: files.map(expand), keys };
}

/** dotenv 子集：`export K=V` / 引号 / `\"` `\\` 转义 / 注释 / 后文件覆盖前文件。 */
export function parseFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[m[1]] = v;
  }
  return out;
}

export function loadValues(cfg: EnvConfig): Record<string, string> {
  const all: Record<string, string> = {};
  for (const f of cfg.files) Object.assign(all, parseFile(f));
  return all;
}

export function list(cfg: EnvConfig): { files: { path: string; exists: boolean; keys: number }[]; keys: { key: string; found: boolean }[] } {
  const files = cfg.files.map((p) => ({ path: p, exists: existsSync(p), keys: existsSync(p) ? Object.keys(parseFile(p)).length : 0 }));
  const values = loadValues(cfg);
  return { files, keys: cfg.keys.map((k) => ({ key: k, found: !!values[k] })) };
}

export function check(cfg: EnvConfig, keys: string[]): { key: string; found: boolean; length: number }[] {
  const values = loadValues(cfg);
  return keys.map((k) => ({ key: k, found: !!values[k], length: values[k]?.length ?? 0 }));
}

export interface RunResult { injected: string[]; missing: string[]; exit: number; redacted: boolean }

/** 把白名单键注入子进程后执行；密钥不进 argv。 */
export function run(
  cfg: EnvConfig,
  cmd: string[],
  opts: { redact?: boolean; dryRun?: boolean; extraEnv?: Record<string, string> } = {},
): RunResult {
  if (!cmd.length) throw new Error("E_USAGE: 需要命令");
  const values = { ...loadValues(cfg), ...(opts.extraEnv || {}) };
  const injected = [...cfg.keys, ...Object.keys(opts.extraEnv || {})].filter((k) => values[k]);
  const missing = cfg.keys.filter((k) => !values[k]);
  if (opts.dryRun) return { injected, missing, exit: 0, redacted: false };

  const [bin, ...args] = cmd;
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  // 凭据 broker 的会话键永远不进子进程（值只按白名单注入）
  delete childEnv.BW_SESSION;
  delete childEnv.BW_PASSWORD;
  for (const k of injected) childEnv[k] = values[k];
  const r = spawnSync(bin, args, {
    stdio: opts.redact ? "pipe" : "inherit",
    env: childEnv,
  });
  if (r.error) throw new Error(`E_CMD: ${bin}: ${r.error.message}`);

  if (opts.redact) {
    let out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    for (const k of injected) {
      const v = values[k];
      if (v) out = out.split(v).join("[REDACTED]");
    }
    process.stdout.write(out);
  }
  return { injected, missing, exit: r.status ?? 1, redacted: !!opts.redact };
}
