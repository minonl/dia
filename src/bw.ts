// bw.ts — Bitwarden CLI 的**单会话 broker**（POC）
//
// 背景（2026-11-04 调研）：BW_SESSION 是 bearer 凭据；每次 `bw unlock` 会让旧 session 全部失效；
// bw 的访问粒度是账号，不是任务。所以 agent 侧不应持有 BW_SESSION，也不能各自 unlock。
//
// 本模块的边界：
//   · session key 只落一个 0600 文件，**永不打印、永不进 argv、永不进被测进程环境**
//   · 取用只按显式映射（ENV=item），取不到即失败（fail-closed）
//   · 子进程只拿到声明的键，且继承的 env 里剔除 BW_SESSION / BW_PASSWORD
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const home = () => process.env.DIA_HOME || homedir();
const dataDir = () => process.env.DIA_DATA_DIR || join(home(), ".local", "share", "dia");

export function sessionFile(): string {
  return process.env.DIA_BW_SESSION_FILE || join(dataDir(), "state", "bw.session");
}

export function readSession(): string | null {
  try {
    const s = readFileSync(sessionFile(), "utf8").trim();
    return s || null;
  } catch { return null; }
}

function writeSession(key: string): void {
  const f = sessionFile();
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, key + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
}

export function clearSession(): void {
  try { rmSync(sessionFile(), { force: true }); } catch { /* ignore */ }
}

function bwBin(): string { return process.env.DIA_BW_BIN || "bw"; }

/** 只给 bw 子进程用的环境：注入 session，剥掉密码。 */
function bwEnv(session: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BW_PASSWORD;
  if (session) env.BW_SESSION = session; else delete env.BW_SESSION;
  return env;
}

export interface BwStatus { status: "unauthenticated" | "locked" | "unlocked" | "unknown"; detail?: string }

export function status(): BwStatus {
  try {
    const out = execFileSync(bwBin(), ["status"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: bwEnv(readSession()) });
    const m = /"status"\s*:\s*"([a-z]+)"/.exec(out);
    const s = (m?.[1] || "unknown") as BwStatus["status"];
    return { status: s };
  } catch (e: any) {
    return { status: "unknown", detail: String(e?.message || e) };
  }
}

/** 解锁并把 session 落盘（不返回 key）。密码来源：--passwordfile 或 BW_PASSWORD 环境变量。 */
export function unlock(opts: { passwordFile?: string } = {}): { ok: true } | { ok: false; error: string } {
  const args = ["unlock", "--raw"];
  if (opts.passwordFile) args.push("--passwordfile", opts.passwordFile);
  try {
    const out = execFileSync(bwBin(), args, {
      encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
      // 注意：解锁时把 BW_PASSWORD 传给 bw（它自己读），但不会再传给任何其他子进程
      env: { ...process.env, BW_SESSION: "" },
    });
    const key = out.trim().split("\n").pop()?.trim() || "";
    if (!key) return { ok: false, error: "E_BW: unlock 没有返回 session（密码错误或需要交互）" };
    writeSession(key);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `E_BW: unlock 失败（${String(e?.message || e).split("\n")[0]}）` };
  }
}

export function lock(): { ok: boolean; error?: string } {
  try {
    execFileSync(bwBin(), ["lock"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: bwEnv(readSession()) });
  } catch (e: any) {
    // 即使 bw lock 失败也要清掉本地 session（避免留可用凭据）
    clearSession();
    return { ok: false, error: String(e?.message || e) };
  }
  clearSession();
  return { ok: true };
}

/** 取一个 vault item 的密码字段；失败即抛（fail-closed，不返回空串冒充成功）。 */
export function getItemPassword(item: string): string {
  const session = readSession();
  if (!session) throw new Error("E_BW: 没有可用 session（先 dia env bw unlock）");
  try {
    const out = execFileSync(bwBin(), ["get", "password", item], {
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: bwEnv(session),
    });
    const v = out.trim();
    if (!v) throw new Error("E_BW: 空值");
    return v;
  } catch (e: any) {
    throw new Error(`E_BW: 读取 ${item} 失败（${String(e?.message || e).split("\n")[0]}）`);
  }
}

export interface Map { env: string; item: string }

/**
 * 按映射解析并执行子进程：只注入映射出的键；继承环境里剔除 BW_SESSION / BW_PASSWORD。
 * 任一条取不到 → 整次失败（不执行子进程）。
 */
export function runMapped(maps: Map[], command: string, args: string[]): { code: number; out: string; err: string } {
  const extra: Record<string, string> = {};
  for (const m of maps) extra[m.env] = getItemPassword(m.item);
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.BW_SESSION;
  delete env.BW_PASSWORD;
  if (!command) throw new Error("E_USAGE: missing command");
  try {
    const out = execFileSync(command, args, { encoding: "utf8", env, stdio: ["inherit", "pipe", "pipe"] });
    return { code: 0, out: String(out), err: "" };
  } catch (e: any) {
    return { code: typeof e?.status === "number" ? e.status : 1, out: String(e?.stdout || ""), err: String(e?.stderr || e?.message || "") };
  }
}

export function parseMaps(raw: string[]): Map[] {
  return raw.map((s) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(s.trim());
    if (!m) throw new Error(`E_USAGE: --map 需要 KEY=item（收到 ${JSON.stringify(s)}）`);
    return { env: m[1], item: m[2] };
  });
}
