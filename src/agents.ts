// dia agents —— 在线 agent 注册表（P1.1）
//
// 为什么需要：`dia msg` 要知道「谁在线、消息往哪个 pane 打」。注册表是**事实源**：
// 每个运行中的席位启动时 `dia agents register` 写一次，之后靠 `--live` 探测 pane 是否还活着。
// 发现顺序：注册表条目（校验 pane 存活 + cmdline/cwd 匹配）→ tmux 会话名回退扫描 → 离线 persona。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "./paths.ts";

const dataDir = () => paths.diaHome();
export const agentsRoot = () => paths.agentsRoot();

export interface AgentRecord {
  agent: string;
  host: "codex" | "dsh" | "opencode" | "terminal" | string;
  pane?: string;          // tmux pane id，如 %3
  session?: string;       // tmux session name
  cwd?: string;
  acp_cmd?: string;      // 例："dsh --profile acp"
  pid?: number;
  registered_at: string;
  last_seen?: string;
}

export interface AgentStatus extends AgentRecord {
  live: boolean;
  /** 存活但身份不符（pane 被复用）——比离线更危险，调用方必须拒绝投递 */
  mismatch?: string;
}

const fileOf = (agent: string) => join(agentsRoot(), `${agent}.json`);

function atomicWrite(path: string, data: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function sh(cmd: string, args: string[]): string | null {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

export function register(rec: Omit<AgentRecord, "registered_at">): AgentRecord {
  if (!rec.agent) throw new Error("E_USAGE: --agent 必填");
  if (!rec.host) throw new Error("E_USAGE: --host 必填");
  const r: AgentRecord = { ...rec, registered_at: new Date().toISOString() };
  atomicWrite(fileOf(rec.agent), JSON.stringify(r, null, 1) + "\n");
  return r;
}

export function unregister(agent: string): boolean {
  const p = fileOf(agent);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

export function read(agent: string): AgentRecord | null {
  const p = fileOf(agent);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as AgentRecord; } catch { return null; }
}

export function all(): AgentRecord[] {
  const root = agentsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(join(root, f), "utf8")) as AgentRecord; } catch { return null; } })
    .filter((r): r is AgentRecord => !!r)
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/** tmux pane 真相：pane 存在时返回当前命令与 cwd */
export function paneInfo(pane: string): { pid: string; command: string; cwd: string; session: string } | null {
  const fmt = "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}";
  const line = sh("tmux", ["display-message", "-p", "-t", pane, fmt]);
  if (!line) return null;
  const [id, pid, command, cwd, session] = line.split("\t");
  if (id !== pane) return null;
  return { pid, command, cwd, session };
}

/**
 * 存活判定：pane 在 → live；若注册时记录了 cwd，要求当前 cwd 一致（防 pane 复用）。
 * 不比较 cmdline（codex 会换子进程/包装器），cwd 是更稳定的身份锚点。
 */
export function statusOf(rec: AgentRecord): AgentStatus {
  if (!rec.pane) return { ...rec, live: false };
  const info = paneInfo(rec.pane);
  if (!info) return { ...rec, live: false };
  if (rec.cwd && resolve(rec.cwd) !== resolve(info.cwd)) {
    return { ...rec, live: false, mismatch: `pane ${rec.pane} 当前 cwd=${info.cwd}，注册时=${rec.cwd}` };
  }
  return { ...rec, live: true, last_seen: new Date().toISOString(), session: rec.session ?? info.session };
}

export function list(opts: { live?: boolean } = {}): AgentStatus[] {
  const rows = all().map((r) => (opts.live ? statusOf(r) : { ...r, live: true }));
  return rows;
}

/** 按 agent 名解析出唯一可投递目标；离线 / 身份不符都抛错（不猜） */
export function resolveTarget(agent: string): AgentStatus {
  const rec = read(agent);
  if (!rec) throw new Error(`E_NO_AGENT: ${agent} 未注册（先 dia agents register）`);
  const st = statusOf(rec);
  if (st.mismatch) throw new Error(`E_PANE_MISMATCH: ${st.mismatch}`);
  if (!st.live || !rec.pane) throw new Error(`E_OFFLINE: ${agent} 不在线（消息请走文件邮箱）`);
  return st;
}

/** 从 tmux 会话名发现未注册的席位（约定 <agent>@<rig>） */
export function discoverTmux(): { agent: string; session: string; pane: string; cwd: string }[] {
  const fmt = "#{session_name}\t#{pane_id}\t#{pane_current_path}";
  const out = sh("tmux", ["list-panes", "-a", "-F", fmt]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((l) => {
    const [session, pane, cwd] = l.split("\t");
    return { agent: session.split("@")[0], session, pane, cwd };
  }).filter((x) => x.agent && x.session.includes("@"));
}

export function baseName(p: string) { return basename(p); }
