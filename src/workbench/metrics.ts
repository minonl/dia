// dia workbench —— 指标聚合（M4，纯函数）
//
// 设计：docs/design/workbench.md §8（8.1 口径 / 8.2 团队模式 / 8.3 输出）
// 硬约束：
//   · 本文件**不读盘、不联网、不解压**：input 由调用方（CLI / 快照）准备好
//   · 不读墙钟：as_of 只取 input.as_of / window.until，缺省为 null（同输入必须字节一致）
//   · tokens 总量取会话级汇总（session_v2 口径），明细取 session_message（detail_source）
//   · cost = 宿主 cost>0 优先，否则 pricing 换算；未知型号 **不猜价**（0 不等于免费）
//   · mode=team 只看 run 的角色集合，**不用会话数**（子会话会把 solo 误判成 team）

import { costOf, type PriceTable } from "../pricing.ts";
import type { Track } from "./schema.ts";

export const METRICS_SCHEMA = 1 as const;

/** 相邻 turn 间隔 ≤ 该值才计入活跃时长（§8.1） */
export const ACTIVE_GAP_MS = 10 * 60_000;
/** 对照样本下限（§8.2）：不足不下结论 */
export const COMPARE_MIN_N = 5;

export interface MetricsWindowInput { since?: string | null; until?: string | null }

export interface MetricTokens {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface MetricSession {
  session_id: string;
  /** 子会话标记：非空即子会话（tokens 上溯到 root 聚合） */
  parent_id?: string | null;
  host?: string;
  /** 会话级汇总（session_v2 列），不是消息级求和 */
  tokens?: MetricTokens;
  /** 宿主自报成本；**> 0 才算有价**，0 / null 一律回落 pricing */
  cost_usd?: number | null;
  models?: string[];
  turns?: number;
  /** 工具调用次数（按工具名） */
  tools?: Record<string, number>;
  tool_errors?: number;
  /** 逐 turn 时间戳（ISO 或 epoch ms），用于活跃时长估算 */
  turn_times?: Array<string | number>;
  first_seen?: string;
  last_activity?: string;
  tracks?: string[];
}

export interface MetricTask {
  id: string;
  status: string;
  judge?: string;
}

export interface MetricRun {
  id?: string;
  /** 关联 track（`dia team` 记录）；缺失时对照按全局 mode 兜底 */
  track?: string;
  role: string;
  /** mock run 不作为团队/返工证据（§8.2） */
  mock?: boolean;
}

export interface MetricsInput {
  /** 注入时钟（`--now`）；缺省不读墙钟 */
  as_of?: string | null;
  window?: MetricsWindowInput;
  sessions?: MetricSession[];
  tracks?: Track[];
  tasks?: MetricTask[];
  runs?: MetricRun[];
  prices?: PriceTable;
  /** goal_type = repo::tag；缺省从 tracks 的第一条推导 */
  goal_type?: { repo?: string; tag?: string };
}

export interface GroupStat {
  n: number;
  tokens_total: number;
  tokens_per_task: number | null;
  active_ms: number;
  active_ms_per_task: number | null;
  rework: number;
  acceptance: { attempted: number; done: number; rate: number | null };
}

export interface MetricsCompare {
  goal_type: string;
  /** 已完成 track 数（team + solo） */
  n: number;
  need_more: number;
  conclusive: boolean;
  verdict: "team" | "solo" | null;
  /** 按当前完成速率预计还需几天才够样本；已够或无法估算 → null */
  eta_days: number | null;
  team: GroupStat;
  solo: GroupStat;
}

export interface HostStat {
  sessions: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number };
  turns: number;
  cost_usd: number | null;
  priced: boolean;
}

export interface WorkbenchMetrics {
  schema_v: typeof METRICS_SCHEMA;
  as_of: string | null;
  window: { since: string | null; until: string | null; approximate: true };
  totals_source: "session_v2";
  detail_source: "session_message";
  priced: boolean;
  unpriced: { sessions: number; models: string[] };
  cost_usd: number | null;
  cost_basis: "host" | "pricing" | "mixed" | "none";
  estimated: { active_ms: true; multi_model_sessions: number };
  mixed_hosts: boolean;
  n: {
    sessions: number;
    parents: number;
    subagents: number;
    tracks: number;
    tasks: number;
    runs: number;
    excluded_mock: number;
    done_tracks: number;
  };
  tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number };
  /** 子会话 tokens 上溯后的 root 聚合（子会话不单独成组） */
  by_root: Array<{ root: string; sessions: number; tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number } }>;
  reconcile: { delta: number; expected_max: number; within_expected: boolean };
  /** 子会话可能已被宿主算进 root 汇总时的保守口径（仅 within_expected=false 时出现） */
  fallback?: {
    strategy: "parent_id IS NULL";
    sessions: number;
    tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number };
    cost_usd: number | null;
  };
  turns: number;
  tools: { total: number; errors: number; failure_rate: number | null; by_tool: Record<string, number> };
  active_ms: number;
  wall_ms: number;
  rework: number;
  acceptance: { attempted: number; done: number; rate: number | null; judge_coverage: number | null };
  mode: "team" | "solo";
  goal_type: string;
  compare: MetricsCompare;
  by_host: Record<string, HostStat>;
  footnote: string;
}

/** 返工轮次（§8.1）：redteam-N / *-repair / builder-fix */
export const REWORK_ROLE_RE = /-repair$|^redteam-\d|^builder-fix$/;
const REDTEAM_ROLE_RE = /^redteam\b/;
const DONE_STATUSES = new Set(["done", "accepted"]);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (v: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const timeOf = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};
const emptyTokens = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 });

function addTokens(acc: ReturnType<typeof emptyTokens>, t: MetricTokens | undefined): void {
  acc.input += num(t?.input);
  acc.output += num(t?.output);
  acc.cache_read += num(t?.cache_read);
  acc.cache_write += num(t?.cache_write);
  acc.total = acc.input + acc.output;
}

/** 活跃时长：相邻 turn 间隔 ≤10min 的累加（估算，estimated:true） */
export function activeMsOf(times: Array<string | number> | undefined): number {
  const ts = (times || []).map(timeOf).filter((x): x is number => x !== null).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap >= 0 && gap <= ACTIVE_GAP_MS) sum += gap;
  }
  return sum;
}

/** 团队模式判定（§8.2）：只看**非 mock** run 的角色集合，不看会话数。 */
export function modeOfRuns(runs: MetricRun[]): "team" | "solo" {
  const roles = new Set(runs.filter((r) => r && !r.mock).map((r) => String(r.role || "").trim()).filter(Boolean));
  const hasBuilder = roles.has("builder");
  const hasVerifier = roles.has("verifier");
  const hasRedteam = [...roles].some((r) => REDTEAM_ROLE_RE.test(r));
  return (hasBuilder && hasVerifier) || hasRedteam ? "team" : "solo";
}

function rootOf(session: MetricSession, byId: Map<string, MetricSession>): string {
  let cur = session;
  const seen = new Set<string>([cur.session_id]);
  for (let i = 0; i < 32; i++) {
    const parent = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    if (!parent || seen.has(parent.session_id)) break;
    seen.add(parent.session_id);
    cur = parent;
  }
  return cur.session_id;
}

interface CostPart {
  usd: number | null;
  priced: boolean;
  basis: "host" | "pricing" | null;
  model: string | null;
}

function sessionCost(s: MetricSession, prices: PriceTable): CostPart {
  const host = Number(s.cost_usd);
  if (Number.isFinite(host) && host > 0) return { usd: host, priced: true, basis: "host", model: null };
  const models = (s.models || []).map((m) => String(m || "").trim()).filter(Boolean);
  if (!models.length) return { usd: null, priced: false, basis: null, model: null };
  const usage = {
    inputTokens: num(s.tokens?.input),
    outputTokens: num(s.tokens?.output),
    cacheReadTokens: num(s.tokens?.cache_read),
    cacheWriteTokens: num(s.tokens?.cache_write),
  };
  const c = costOf(models[0], usage, prices);
  if (!c.priced || c.usd === null) return { usd: null, priced: false, basis: null, model: models[0] };
  return { usd: c.usd, priced: true, basis: "pricing", model: models[0] };
}

const FOOTNOTE = [
  "口径与估算说明：tokens 取会话级汇总（totals_source=session_v2，cache 单列，total=input+output）；",
  "明细（turns/tools）来自 session_message（detail_source），只算执行失败，排除 idle/synthetic；",
  "费用 = 宿主 cost>0 优先，否则按 prices 表换算；未知型号不猜价（该会话 cost 记 null），0 不等于免费；",
  "cost_usd 只累加已知价：unpriced>0 时 priced=false 表示总额不完整（不把未知当 0）；",
  "active_ms 按相邻 turn 间隔 ≤10min 累加（estimated:true），wall_ms 含挂起仅参考；",
  "mode 只由非 mock run 的角色集合判定，不用会话数；对照样本不足不下结论。",
].join("");

export function buildMetrics(input: MetricsInput = {}): WorkbenchMetrics {
  const window = input.window || {};
  const since = window.since ?? null;
  const until = window.until ?? null;
  const sinceMs = timeOf(since);
  const untilMs = timeOf(until);
  const prices = input.prices || {};
  const tracks = input.tracks || [];
  const tasks = input.tasks || [];
  const runs = input.runs || [];

  const inWindow = (s: MetricSession): boolean => {
    const t = timeOf(s.last_activity);
    if (t === null) return true;
    if (sinceMs !== null && t < sinceMs) return false;
    if (untilMs !== null && t > untilMs) return false;
    return true;
  };
  const sessions = (input.sessions || []).filter(inWindow);

  // ── tokens（会话级汇总）────────────────────────────────────────────────────
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const total = emptyTokens();
  const rootTokens = emptyTokens();
  const perRoot = new Map<string, ReturnType<typeof emptyTokens>>();
  const perRootCount = new Map<string, number>();
  let parents = 0;
  let subagents = 0;

  for (const s of sessions) {
    addTokens(total, s.tokens);
    if (s.parent_id) subagents++;
    else {
      parents++;
      addTokens(rootTokens, s.tokens);
    }
    // 子会话 tokens 一律上溯到 root（§8.1）
    const root = rootOf(s, byId);
    const acc = perRoot.get(root) || emptyTokens();
    addTokens(acc, s.tokens);
    perRoot.set(root, acc);
    perRootCount.set(root, (perRootCount.get(root) || 0) + 1);
  }

  // 子会话增量 = 若宿主已把子会话算进 root 汇总，最多会重复计的幅度
  const delta = total.total - rootTokens.total;
  const expectedMax = Math.round(rootTokens.total * 0.01);
  const withinExpected = delta <= expectedMax;

  // ── 成本 ────────────────────────────────────────────────────────────────
  let costSum = 0;
  let pricedCount = 0;
  let rootCostSum = 0;
  let rootPricedCount = 0;
  let multiModel = 0;
  const unpricedModels = new Set<string>();
  const bases = new Set<"host" | "pricing">();
  const hostAcc = new Map<string, HostStat>();

  for (const s of sessions) {
    const host = String(s.host || "unknown");
    const stat = hostAcc.get(host) || { sessions: 0, tokens: emptyTokens(), turns: 0, cost_usd: null, priced: false };
    stat.sessions++;
    addTokens(stat.tokens, s.tokens);
    stat.turns += num(s.turns);

    const c = sessionCost(s, prices);
    if (c.priced && c.usd !== null) {
      costSum += c.usd;
      pricedCount++;
      if (c.basis) bases.add(c.basis);
      stat.cost_usd = (stat.cost_usd ?? 0) + c.usd;
      if (!s.parent_id) {
        rootCostSum += c.usd;
        rootPricedCount++;
      }
    } else {
      unpricedModels.add(c.model || "(unknown)");
    }
    hostAcc.set(host, stat);

    const models = (s.models || []).filter(Boolean);
    if (models.length > 1) multiModel++;
  }
  for (const [host, stat] of hostAcc) {
    stat.priced = stat.cost_usd !== null;
    stat.cost_usd = stat.cost_usd === null ? null : round(stat.cost_usd, 6);
    hostAcc.set(host, stat);
  }

  const costUsd = pricedCount > 0 ? round(costSum, 6) : null;
  const costBasis: WorkbenchMetrics["cost_basis"] =
    bases.size === 0 ? "none" : bases.size > 1 ? "mixed" : [...bases][0];

  // ── 过程（turns / tools / 时长）──────────────────────────────────────────
  let turns = 0;
  let toolsTotal = 0;
  let toolErrors = 0;
  let activeMs = 0;
  let wallMs = 0;
  const byTool: Record<string, number> = {};

  for (const s of sessions) {
    turns += num(s.turns);
    for (const [name, n] of Object.entries(s.tools || {})) {
      const v = num(n);
      if (!name || !v) continue;
      byTool[name] = (byTool[name] || 0) + v;
      toolsTotal += v;
    }
    toolErrors += num(s.tool_errors);
    activeMs += activeMsOf(s.turn_times);
    const first = timeOf(s.first_seen);
    const last = timeOf(s.last_activity);
    if (first !== null && last !== null && last >= first) wallMs += last - first;
  }
  const byToolSorted: Record<string, number> = {};
  for (const k of Object.keys(byTool).sort()) byToolSorted[k] = byTool[k];

  // ── 结果（tasks）─────────────────────────────────────────────────────────
  const attempted = tasks.filter((t) => String(t.status) !== "dropped");
  const done = attempted.filter((t) => DONE_STATUSES.has(String(t.status)));
  const withJudge = attempted.filter((t) => String(t.judge || "").trim());
  const acceptance = {
    attempted: attempted.length,
    done: done.length,
    rate: attempted.length ? round(done.length / attempted.length, 4) : null,
    judge_coverage: attempted.length ? round(withJudge.length / attempted.length, 4) : null,
  };

  // ── run（harness）：mock 排除、返工、mode ────────────────────────────────
  const realRuns = runs.filter((r) => r && !r.mock);
  const excludedMock = runs.filter((r) => r && r.mock).length;
  const rework = realRuns.filter((r) => REWORK_ROLE_RE.test(String(r.role || ""))).length;
  const mode = modeOfRuns(realRuns);

  // ── 对照（§8.2）：goal_type 分组，n=已完成 track 数 ─────────────────────
  const goalType = goalTypeOf(input, tracks);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const emptyGroup = (): GroupStat => ({
    n: 0,
    tokens_total: 0,
    tokens_per_task: null,
    active_ms: 0,
    active_ms_per_task: null,
    rework: 0,
    acceptance: { attempted: 0, done: 0, rate: null },
  });
  const groups: Record<"team" | "solo", GroupStat> = { team: emptyGroup(), solo: emptyGroup() };
  const doneTracks = tracks.filter((t) => String(t.status) === "done");

  const modeOfTrack = (track: Track): "team" | "solo" => {
    const own = realRuns.filter((r) => r.track === track.id);
    if (own.length) return modeOfRuns(own);
    if (realRuns.length && realRuns.every((r) => !r.track)) return mode;
    return "solo";
  };

  for (const track of doneTracks) {
    const g = groups[modeOfTrack(track)];
    g.n++;
    const boundIds = new Set(track.sessions.map((s) => s.session_id));
    const own = sessions.filter((s) => (s.tracks || []).includes(track.id) || boundIds.has(s.session_id));
    for (const s of own) {
      g.tokens_total += totalOf(s.tokens);
      g.active_ms += activeMsOf(s.turn_times);
    }
    g.rework += realRuns.filter((r) => r.track === track.id && REWORK_ROLE_RE.test(String(r.role || ""))).length;
    for (const id of track.tasks) {
      const task = taskById.get(id);
      if (!task || String(task.status) === "dropped") continue;
      g.acceptance.attempted++;
      if (DONE_STATUSES.has(String(task.status))) g.acceptance.done++;
    }
  }
  for (const key of ["team", "solo"] as const) {
    const g = groups[key];
    g.tokens_per_task = g.n ? round(g.tokens_total / g.n, 2) : null;
    g.active_ms_per_task = g.n ? Math.round(g.active_ms / g.n) : null;
    g.acceptance.rate = g.acceptance.attempted ? round(g.acceptance.done / g.acceptance.attempted, 4) : null;
  }

  const compareN = doneTracks.length;
  const needMore = Math.max(0, COMPARE_MIN_N - compareN);
  const conclusive = compareN >= COMPARE_MIN_N;
  const verdict = conclusive ? verdictOf(groups.team, groups.solo) : null;
  let etaDays: number | null = null;
  if (!conclusive && sinceMs !== null && untilMs !== null && untilMs > sinceMs && compareN > 0) {
    const days = (untilMs - sinceMs) / 86_400_000;
    const rate = compareN / days;
    etaDays = rate > 0 ? Math.max(1, Math.ceil(needMore / rate)) : null;
  }

  const hosts = [...hostAcc.keys()].sort();
  const byHost: Record<string, HostStat> = {};
  for (const h of hosts) byHost[h] = hostAcc.get(h)!;

  const out: WorkbenchMetrics = {
    schema_v: METRICS_SCHEMA,
    as_of: input.as_of ?? until ?? null,
    window: { since, until, approximate: true },
    totals_source: "session_v2",
    detail_source: "session_message",
    priced: unpricedModels.size === 0 && costUsd !== null,
    unpriced: { sessions: sessions.length - pricedCount, models: [...unpricedModels].sort() },
    cost_usd: costUsd,
    cost_basis: costBasis,
    estimated: { active_ms: true, multi_model_sessions: multiModel },
    mixed_hosts: hosts.filter((h) => h !== "unknown").length > 1,
    n: {
      sessions: sessions.length,
      parents,
      subagents,
      tracks: tracks.length,
      tasks: tasks.length,
      runs: realRuns.length,
      excluded_mock: excludedMock,
      done_tracks: compareN,
    },
    tokens: total,
    by_root: [...perRoot.keys()].sort().map((root) => ({
      root,
      sessions: perRootCount.get(root) ?? 1,
      tokens: perRoot.get(root)!,
    })),
    reconcile: { delta, expected_max: expectedMax, within_expected: withinExpected },
    turns,
    tools: {
      total: toolsTotal,
      errors: toolErrors,
      failure_rate: toolsTotal ? round(toolErrors / toolsTotal, 4) : null,
      by_tool: byToolSorted,
    },
    active_ms: activeMs,
    wall_ms: wallMs,
    rework,
    acceptance,
    mode,
    goal_type: goalType,
    compare: {
      goal_type: goalType,
      n: compareN,
      need_more: needMore,
      conclusive,
      verdict,
      eta_days: etaDays,
      team: groups.team,
      solo: groups.solo,
    },
    by_host: byHost,
    footnote: FOOTNOTE,
  };
  if (!withinExpected) {
    out.fallback = {
      strategy: "parent_id IS NULL",
      sessions: parents,
      tokens: rootTokens,
      cost_usd: rootPricedCount > 0 ? round(rootCostSum, 6) : null,
    };
  }
  return out;
}

function totalOf(t: MetricTokens | undefined): number {
  return num(t?.input) + num(t?.output);
}

function goalTypeOf(input: MetricsInput, tracks: Track[]): string {
  const repo = input.goal_type?.repo ?? tracks.find((t) => (t.repo || []).length)?.repo[0] ?? "unknown";
  const tag = input.goal_type?.tag ?? tracks.find((t) => String(t.stage || "").trim())?.stage ?? "unknown";
  return `${repo}::${tag}`;
}

/** team vs solo：逐项比优劣取多数（null 项不参与）。 */
function verdictOf(team: GroupStat, solo: GroupStat): "team" | "solo" | null {
  let t = 0;
  let s = 0;
  const lower = (a: number | null, b: number | null) => {
    if (a === null || b === null || a === b) return;
    if (a < b) t++;
    else s++;
  };
  const higher = (a: number | null, b: number | null) => {
    if (a === null || b === null || a === b) return;
    if (a > b) t++;
    else s++;
  };
  lower(team.tokens_per_task, solo.tokens_per_task);
  lower(team.active_ms_per_task, solo.active_ms_per_task);
  lower(team.rework, solo.rework);
  higher(team.acceptance.rate, solo.acceptance.rate);
  if (t === s) return null;
  return t > s ? "team" : "solo";
}
