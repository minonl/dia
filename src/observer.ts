// dia collab observer（M3a）：只读观察器
// 设计：docs/design/comm-semantics.md §7
// 红线：只扫消息文件 + 写 board/metrics/escalations；不写消息状态、不代答、不联网。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as collab from "./collab.ts";
import * as paths from "./paths.ts";

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
  intervalSec?: number;
  /** 默认 ~/.dia/collab；测试可注入 */
  root?: string;
}

const TERMINAL = new Set(["replied", "closed"]);
const SLA_MS: Record<number, number> = { 0: 30 * 60_000, 1: 4 * 3600_000 };

const rootOf = (o: ObserveOptions) => o.root ?? join(paths.diaHome(), "collab");
const stateDir = (o: ObserveOptions) => join(rootOf(o), "state");
const metricsDir = (o: ObserveOptions) => join(rootOf(o), "metrics");
const boardFile = (o: ObserveOptions) => join(stateDir(o), "board.json");
const escalationsFile = (o: ObserveOptions) => join(rootOf(o), "escalations.jsonl");

const ts = (s?: string) => { if (!s) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : t; };

export function boardPath(): string { return join(paths.diaHome(), "collab", "state", "board.json"); }

/** 一次 tick：扫描 → 写 board / 当日 metrics 快照 / escalations；返回 board */
export function observe(opts: ObserveOptions = {}): Board {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const interval = opts.intervalSec ?? 60;
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

  // 升级事件：P0 超过 30m / P1 超过 4h 仍未送达
  const esc: any[] = [];
  for (const m of all) {
    const c = cls(m);
    const limit = SLA_MS[c];
    if (limit === undefined || m.delivered_at) continue;
    const a = age(m);
    if (a > limit) esc.push({ ts: now.toISOString(), id: m.id, class: `P${c}`, age_ms: a, kind: "undelivered" });
  }

  const board: Board = {
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
    escalations: esc.length,
  };

  mkdirSync(stateDir(opts), { recursive: true, mode: 0o700 });
  writeFileSync(boardFile(opts), JSON.stringify(board, null, 1) + "\n", { mode: 0o600 });

  // 当日 metrics 快照（按天覆盖：同一日多次 tick 用最新值；不累积历史事件）
  try {
    const day = board.generated_at.slice(0, 10);
    const st = collab.messageStats({ since: "7d", now });
    mkdirSync(metricsDir(opts), { recursive: true, mode: 0o700 });
    writeFileSync(join(metricsDir(opts), `${day}.json`), JSON.stringify(st, null, 1) + "\n", { mode: 0o600 });
  } catch { /* 指标失败不影响 board */ }

  if (esc.length) {
    mkdirSync(rootOf(opts), { recursive: true, mode: 0o700 });
    appendFileSync(escalationsFile(opts), esc.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  }
  return board;
}

/** 读缓存 board（hook 用，≤50ms）：缺失或过期则现算一次 */
export function readBoard(opts: ObserveOptions = {}): Board {
  const f = boardFile(opts);
  try {
    if (existsSync(f)) {
      const b = JSON.parse(readFileSync(f, "utf8")) as Board;
      const age = Date.now() - ts(b.generated_at)!;
      if (age <= (b.interval_s || 60) * 2 * 1000) return b;
    }
  } catch { /* fall through */ }
  return observe(opts);
}

export function boardFileMode(opts: ObserveOptions = {}): number {
  try { return statSync(boardFile(opts)).mode & 0o777; } catch { return 0; }
}
