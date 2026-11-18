// dia workbench —— 采集总入口（M1）
//
// 设计：docs/design/workbench.md §4（采集器）/ §4.5（契约）
// 原则：
//   · 每个采集器独立 try/catch：一个坏掉不影响其他（sources 带 status/duration_ms）
//   · 只读宿主库与 git；不写任何宿主数据
//   · 输出排序稳定，保证同一 --now 下快照可比（duration_ms 除外）

import * as claimsStore from "../../claims.ts";
import type { Alert, SessionView, Snapshot, SourceStatus, Track } from "../schema.ts";
import * as store from "../store.ts";
import { collectOpencode } from "./opencode.ts";
import { collectRegistry, mergeSessions } from "./registry.ts";
import { collectWorktrees } from "./worktrees.ts";

const LIVENESS = { aliveMin: 15, suspectH: 12 } as const;

export interface CollectAllOpts {
  now?: Date;
  depth?: "fast" | "full";
  /** 折叠后的 track（用于把活跃绑定回填到 session.tracks） */
  tracks?: Track[];
  /** opencode 库路径（测试注入；缺省走宿主默认路径） */
  opencodeDbPath?: string;
  /** 显式仓根（--cwd 覆盖 / 测试） */
  repoPaths?: string[];
  /** 额外 cwd（--cwd 覆盖 / 测试） */
  cwds?: string[];
  gitTimeoutMs?: number;
}

export interface CollectAllResult {
  sessions: SessionView[];
  worktrees: Snapshot["worktrees"];
  sources: Record<string, SourceStatus>;
  alerts: Alert[];
}

export function collectAll(opts: CollectAllOpts = {}): CollectAllResult {
  const now = opts.now || new Date();
  const depth = opts.depth || "fast";
  const sources: Record<string, SourceStatus> = {};
  const alerts: Alert[] = [];
  const tracks = opts.tracks || [];

  // 1) claim 租约（活跃）——既用于 session.route_eligible，也用于 worktree.dirty 门控
  let activeClaims: claimsStore.Claim[] = [];
  const claimStarted = Date.now();
  try {
    activeClaims = claimsStore.list({ now });
    sources.claims = { status: "ok", duration_ms: Date.now() - claimStarted, detail: `${activeClaims.length} active` };
  } catch (e: any) {
    sources.claims = { status: "degraded", duration_ms: Date.now() - claimStarted, detail: String(e?.message || e).slice(0, 160) };
  }
  const claimedSessions = new Set(activeClaims.map((c) => c.holder));

  // 2) 宿主（opencode v2 only）
  let hostSessions: SessionView[] = [];
  try {
    const r = collectOpencode({
      now,
      dbPath: opts.opencodeDbPath,
      aliveMin: LIVENESS.aliveMin,
      suspectH: LIVENESS.suspectH,
      claimed: claimedSessions,
    });
    hostSessions = r.sessions;
    sources.opencode = r.source;
    if (r.source.status === "unsupported") {
      alerts.push({
        level: "warn",
        kind: "opencode-unsupported",
        subject: "opencode.db",
        detail: `${r.source.detail || "缺少 session_v2"}；需升级宿主或跑 \`dia wb migrate\`（看板只用 v2）`,
      });
    } else if (r.source.status !== "ok") {
      alerts.push({
        level: "warn",
        kind: "opencode-degraded",
        subject: "opencode.db",
        detail: r.source.detail || r.source.status,
      });
    }
  } catch (e: any) {
    sources.opencode = { status: "degraded", detail: String(e?.message || e).slice(0, 160) };
    alerts.push({ level: "warn", kind: "opencode-degraded", subject: "opencode.db", detail: String(e?.message || e).slice(0, 160) });
  }

  // 3) collab 注册表（身份/pane/cwd 补充）
  let registrySessions: SessionView[] = [];
  try {
    const r = collectRegistry({ now, aliveMin: LIVENESS.aliveMin, suspectH: LIVENESS.suspectH, claimed: claimedSessions });
    registrySessions = r.sessions;
    sources.registry = r.source;
  } catch (e: any) {
    sources.registry = { status: "degraded", detail: String(e?.message || e).slice(0, 160) };
  }

  let sessions = mergeSessions(hostSessions, registrySessions);

  // 4) 心跳（beats.jsonl）：只加分，不改宿主判定（§5.2 证据优先级 4）
  const beatsStarted = Date.now();
  const heartbeats = new Map<string, string>();
  try {
    const { rows, bad } = store.readBeats();
    for (const b of rows) {
      if (!b?.session || !b.ts) continue;
      const prev = heartbeats.get(b.session);
      const t = Date.parse(b.ts);
      if (Number.isNaN(t)) continue;
      if (!prev || t > Date.parse(prev)) heartbeats.set(b.session, b.ts);
    }
    sources.beats = { status: "ok", duration_ms: Date.now() - beatsStarted, detail: `${rows.length} beats` };
    if (bad) alerts.push({ level: "info", kind: "beats-corrupt", subject: "beats.jsonl", detail: `${bad} 行无法解析` });
  } catch (e: any) {
    sources.beats = { status: "degraded", duration_ms: Date.now() - beatsStarted, detail: String(e?.message || e).slice(0, 160) };
  }

  // 5) track 绑定回填 + 心跳佐证（suspect + 15min 内心跳 → route_eligible）
  const trackBySession = new Map<string, string[]>();
  for (const t of tracks) {
    if (t.status === "done" || t.status === "abandoned") continue;
    for (const s of t.sessions) {
      if (s.unbound_at) continue;
      const ids = trackBySession.get(s.session_id) || [];
      ids.push(t.id);
      trackBySession.set(s.session_id, ids);
    }
  }
  for (const s of sessions) {
    const hb = heartbeats.get(s.session_id) || null;
    s.last_heartbeat = hb;
    const bound = trackBySession.get(s.session_id);
    if (bound) s.tracks = [...new Set([...s.tracks, ...bound])].sort();
    if (!hb) continue;
    const ageMs = now.getTime() - Date.parse(hb);
    if (Number.isNaN(ageMs)) continue;
    s.liveness_evidence.push({
      source: "beat",
      ts: hb,
      weight: "support",
      detail: `heartbeat ${Math.max(0, Math.round(ageMs / 60_000))}m`,
    });
    if (s.liveness === "suspect" && !s.route_eligible && ageMs <= LIVENESS.aliveMin * 60_000) {
      s.route_eligible = true;
      s.liveness_evidence.push({ source: "beat", ts: hb, weight: "support", detail: "15min 内心跳 → 可路由" });
    }
  }
  sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));

  // 6) worktree（多仓）
  let worktrees: Snapshot["worktrees"] = { schema_v: 1, repos: [] };
  try {
    const cwds = [...sessions.map((s) => s.cwd).filter(Boolean), ...(opts.cwds || [])];
    const r = collectWorktrees({
      cwds,
      repoPaths: opts.repoPaths,
      depth,
      now,
      claims: activeClaims,
      timeoutMs: opts.gitTimeoutMs,
    });
    worktrees = r.worktrees;
    sources.worktrees = r.source;
    const wts = worktrees.repos.flatMap((x) => x.worktrees);
    const prunable = wts.filter((w) => w.prunable).length;
    if (prunable) alerts.push({ level: "info", kind: "wt-prunable", subject: "worktrees", detail: `${prunable} 棵 prunable（可 dia wt clean 回收，需人工确认）` });
    const shared = wts.filter((w) => w.flags.includes("shared")).length;
    if (shared) alerts.push({ level: "warn", kind: "wt-shared", subject: "worktrees", detail: `${shared} 棵树被多个 claim 共享（shared 需理由）` });
    const mainDirty = wts.filter((w) => w.flags.includes("main-dirty")).length;
    if (mainDirty) alerts.push({ level: "info", kind: "wt-main-dirty", subject: "worktrees", detail: `${mainDirty} 个主 checkout 有未提交改动（可能是并行会话）` });
  } catch (e: any) {
    sources.worktrees = { status: "degraded", detail: String(e?.message || e).slice(0, 160) };
    alerts.push({ level: "warn", kind: "worktrees-degraded", subject: "git", detail: String(e?.message || e).slice(0, 160) });
  }

  return { sessions, worktrees, sources, alerts };
}
