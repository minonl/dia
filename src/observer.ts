// dia collab observer（M3a）：只读看板 + 一次性 tick
// 设计：docs/design/comm-semantics.md §7
// 约束：一次只跑一个 tick（定时交给 dia job）；不写消息状态；不常驻；不联网。
import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, join } from "node:path";
import * as collab from "./collab.ts";
import * as paths from "./paths.ts";
import * as job from "./job.ts";

export interface Board {
  schema: 1;
  generated_at: string;
  interval_s: number;
  open: number;
  p0: number;
  p1: number;
  undelivered: number;
  oldest_age_ms: number;
  sessions: { id: string; open: number; oldest_age_ms: number }[];
  top: { id: string; class: number; subject: string; age_ms: number }[];
  escalations: number;
}

export interface ObserveOptions {
  now?: Date;
  /** 生产 cadence（秒）；默认取已有 board 的 interval_s，再退到 300 */
  intervalSec?: number;
  root?: string;
}

export interface BoardState {
  board: Board | null;
  /** 快照是否已过期/不可信 */
  stale: boolean;
  age_ms: number | null;
  missing: boolean;
  persisted: boolean;
}

/** 找到当前 dia 可执行文件（launchd/cron 的 PATH 不含 ~/.local/bin，必须写绝对路径） */
export function diaBin(): string {
  if (process.env.DIA_BIN) return process.env.DIA_BIN;
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "dia");
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return "dia";
}

export const DEFAULT_INTERVAL_S = 300;
export const MIN_INTERVAL_S = 60;
export const MAX_INTERVAL_S = 450;

export function normInterval(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_INTERVAL_S;
  const n = Math.trunc(v);
  if (n < MIN_INTERVAL_S || n > MAX_INTERVAL_S) return DEFAULT_INTERVAL_S;
  return n;
}

/** TTL = 2×interval，且必须 > interval+60s；上限 900s */
export function ttlMs(intervalSec: number): number {
  const base = normInterval(intervalSec);
  return Math.min(900_000, Math.max(base * 2000, base * 1000 + 60_000));
}

const rootOf = (o: ObserveOptions) => o.root ?? join(paths.diaHome(), "collab");
const stateDir = (o: ObserveOptions) => join(rootOf(o), "state");
const metricsDir = (o: ObserveOptions) => join(rootOf(o), "metrics");
const boardFile = (o: ObserveOptions) => join(stateDir(o), "board.json");
const escalatedFile = (o: ObserveOptions) => join(stateDir(o), "escalated.json");
const escalationsFile = (o: ObserveOptions) => join(rootOf(o), "escalations.jsonl");

const ts = (s?: string) => { if (!s) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : t; };

export function boardPath(root?: string): string { return join(root ?? join(paths.diaHome(), "collab"), "state", "board.json"); }

const TERMINAL = new Set(["replied", "closed"]);
const SLA_MS: Record<number, number> = { 0: 30 * 60_000, 1: 4 * 3600_000 };

/** 纯计算：扫描消息 → board（不写盘） */
export function buildBoard(opts: ObserveOptions = {}): Board {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const interval = normInterval(opts.intervalSec ?? readInterval(opts));
  const all = collab.allMessages().filter((m) => !m.legacy && !TERMINAL.has(m.state));
  const age = (m: any) => { const t = ts(m.created_at); return t === null ? 0 : Math.max(0, nowMs - t); };
  const cls = (m: any) => (typeof m.class_snapshot === "number" ? m.class_snapshot : 2);

  const sessions = new Map<string, { id: string; open: number; oldest_age_ms: number }>();
  for (const m of all) {
    const s = sessions.get(m.to.session_id) ?? { id: m.to.session_id, open: 0, oldest_age_ms: 0 };
    s.open++;
    s.oldest_age_ms = Math.max(s.oldest_age_ms, age(m));
    sessions.set(m.to.session_id, s);
  }

  const top = all.slice()
    .sort((a, b) => cls(a) - cls(b) || age(b) - age(a))
    .slice(0, 5)
    .map((m) => ({ id: m.id, class: cls(m), subject: m.subject, age_ms: age(m) }));

  const escalated = all.filter((m) => {
    const c = cls(m); const limit = SLA_MS[c];
    return limit !== undefined && !m.delivered_at && age(m) > limit;
  });

  return {
    schema: 1,
    generated_at: now.toISOString(),
    interval_s: interval,
    open: all.length,
    p0: all.filter((m) => cls(m) === 0).length,
    p1: all.filter((m) => cls(m) === 1).length,
    undelivered: all.filter((m) => !m.delivered_at).length,
    oldest_age_ms: all.reduce((x, m) => Math.max(x, age(m)), 0),
    sessions: [...sessions.values()].sort((a, b) => b.oldest_age_ms - a.oldest_age_ms),
    top,
    escalations: escalated.length,
  };
}

function readInterval(opts: ObserveOptions): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(boardFile(opts), "utf8"));
    return typeof raw?.interval_s === "number" ? raw.interval_s : undefined;
  } catch { return undefined; }
}

function chmodDir(dir: string) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch { /* ignore */ } }
function writeFile600(path: string, data: string) {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

/** 一次性 tick：写 board/metrics/escalations；返回 board */
export function observe(opts: ObserveOptions = {}): Board {
  const now = opts.now ?? new Date();
  const interval = normInterval(opts.intervalSec ?? readInterval(opts));
  const board = buildBoard({ ...opts, now, intervalSec: interval });
  const done = (b: Board): Board => b;

  chmodDir(stateDir(opts));
  writeFile600(boardFile(opts), JSON.stringify(board, null, 1) + "\n");

  try {
    const day = board.generated_at.slice(0, 10);
    const st = collab.messageStats({ since: "7d", now });
    chmodDir(metricsDir(opts));
    writeFile600(join(metricsDir(opts), `${day}.json`), JSON.stringify(st, null, 1) + "\n");
  } catch { /* 指标失败不影响 board */ }

  // 升级事件：按 `${id}:${class}` 去重（状态文件只是「当前仍升级中」集合，有界）
  try {
    const currently = buildEscalations(opts, now);
    const keys = new Set(currently.map((e) => `${e.id}:${e.class}`));
    let prev: string[] = [];
    try { const raw = JSON.parse(readFileSync(escalatedFile(opts), "utf8")); if (Array.isArray(raw)) prev = raw.filter((x) => typeof x === "string"); } catch { /* none */ }
    const seen = new Set(prev);
    const fresh = currently.filter((e) => !seen.has(`${e.id}:${e.class}`));
    if (fresh.length) {
      chmodDir(rootOf(opts));
      appendFileSync(escalationsFile(opts), fresh.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
      try { chmodSync(escalationsFile(opts), 0o600); } catch { /* ignore */ }
    }
    writeFile600(escalatedFile(opts), JSON.stringify([...keys].sort(), null, 1) + "\n");
  } catch { /* ignore */ }

  return done(board);
}

function buildEscalations(opts: ObserveOptions, now: Date) {
  const nowMs = now.getTime();
  const out: any[] = [];
  for (const m of collab.allMessages()) {
    if (m.legacy || TERMINAL.has(m.state)) continue;
    const c = typeof m.class_snapshot === "number" ? m.class_snapshot : 2;
    const limit = SLA_MS[c];
    if (limit === undefined || m.delivered_at) continue;
    const t = ts(m.created_at);
    const age = t === null ? 0 : Math.max(0, nowMs - t);
    if (age > limit) out.push({ ts: now.toISOString(), id: m.id, class: `P${c}`, age_ms: age, kind: "undelivered" });
  }
  return out;
}

/** 读缓存状态（不写盘）：fresh / stale / missing */
export function readBoardState(opts: ObserveOptions = {}): BoardState {
  const now = opts.now ?? new Date();
  let raw: any = null;
  try { raw = JSON.parse(readFileSync(boardFile(opts), "utf8")); } catch { raw = null; }
  const missing = !raw || raw.schema !== 1;
  const at = missing ? null : ts(raw.generated_at);
  const age = at === null ? null : now.getTime() - at;
  const interval = normInterval(raw?.interval_s ?? opts.intervalSec);
  const ttl = ttlMs(interval);
  const future = at !== null && at > now.getTime() + 5_000;
  const fresh = !missing && age !== null && age >= 0 && !future && age <= ttl;
  if (fresh) return { board: raw as Board, stale: false, age_ms: age, missing: false, persisted: true };
  const computed = buildBoard({ ...opts, now, intervalSec: interval });
  return { board: computed, stale: true, age_ms: age, missing: missing || future, persisted: false };
}

/** 兼容包装：返回 board（缺失/过期时内存现算，不写盘） */
export function readBoard(opts: ObserveOptions = {}): Board {
  return readBoardState(opts).board!;
}

/** 幂等注册观察器定时（300s）；返回错误信息或 null。由 `dia collab enable` 调用。 */
export function ensureJob(): string | null {
  const NAME = "collab-observe";
  try {
    const regPath = join(job.jobRootResolved(), "tasks", "registry.json");
    let tasks: Record<string, any> = {};
    try { tasks = JSON.parse(readFileSync(regPath, "utf8"))?.tasks || {}; } catch { /* none */ }
    if (Object.keys(tasks).some((k) => k === NAME || k.endsWith(`.${NAME}`))) return null;
    const cmd = `'${diaBin()}' collab observe`;
    const base = ["install", NAME, "--desc", "collab board 刷新（dia collab enable 注册）", "--interval", "300", "--cmd", cmd];
    let r = job.runJobCapture(base);
    // 门控 rc=4：npm 全局的 `dia` 不是 git checkout，class=unknown。命令本身固定且稳定，按逃生舱重试一次。
    if (r.status === 4) r = job.runJobCapture([...base, "--allow-unstable"]);
    if (r.status !== 0) return (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n")[0];
    return null;
  } catch (e: any) {
    return e?.message || String(e);
  }
}

export function boardFileMode(opts: ObserveOptions = {}): number {
  try { return statSync(boardFile(opts)).mode & 0o777; } catch { return 0; }
}
