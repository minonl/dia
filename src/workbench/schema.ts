// dia workbench —— 数据契约（v1）
//
// 设计：docs/design/workbench.md §3
// 原则：意图（track/claim/handoff）由 agent 写；其余全部派生、可重建、可整删。
// 本文件只放类型与常量；不读写磁盘。

export const SNAPSHOT_SCHEMA = 1 as const;

export type TrackStatus = "open" | "active" | "paused" | "blocked" | "awaiting_human" | "done" | "abandoned";
export type SessionRole = "lead" | "worker" | "reviewer";
export type Liveness = "alive" | "suspect" | "dead";

export interface TrackSessionRef {
  session_id: string;
  role: SessionRole;
  host: string;
  bound_at: string;
  unbound_at?: string;
}

export interface TrackRef {
  kind: "mr" | "issue" | "rq" | "spec" | "doc";
  value: string;
  repo?: string;
  url?: string;
}

export interface WaitingOn {
  kind: "human" | "session" | "mr" | "dep" | "date";
  ref: string;
  note?: string;
}

/** 折叠后的 track（只含意图字段；派生字段由 snapshot 注入） */
export interface Track {
  id: string;
  title: string;
  goal: string;
  status: TrackStatus;
  stage: string;
  next: string;
  waiting_on?: WaitingOn;
  remind_at?: string;
  repo: string[];
  prio: string;
  owner?: string;
  refs: TrackRef[];
  sessions: TrackSessionRef[];
  tasks: string[];
  handoff?: { from: string; to: string; at: string; reason: string };
  created_at: string;
  updated_at: string;
  closed_reason?: string;
}

export type SourceStatusKind = "ok" | "degraded" | "timeout" | "unavailable" | "unsupported" | "skipped" | "cached";
export interface SourceStatus {
  status: SourceStatusKind;
  duration_ms?: number;
  detail?: string;
  /** opencode 实际使用的表版本；其他来源可省略 */
  schema?: "v2" | "legacy" | "absent";
}

export interface SessionView {
  schema_v: 1;
  session_id: string;
  parent_id?: string;
  host: string;
  host_scope: string;
  cwd: string;
  repo?: string;
  branch?: string;
  tracks: string[];
  first_seen?: string;
  last_activity?: string;
  last_heartbeat?: string | null;
  liveness: Liveness;
  liveness_evidence: Array<{
    source: "host" | "registry" | "claim" | "beat" | "pane" | "process";
    ts?: string | null;
    weight: "primary" | "support" | "none" | "weak-negative";
    detail?: string;
  }>;
  resumable: boolean;
  delivery_ready: boolean;
  route_eligible: boolean;
  turns?: number;
  tools?: Record<string, number>;
  tool_errors?: number;
  tokens?: { input: number; output: number; cache_read: number; cache_write: number };
  cost_usd?: number | null;
  priced?: boolean;
  models?: string[];
  title?: string;
  raw_ref?: string;
}

export interface ClaimView {
  id: string;
  holder: string;
  track?: string;
  lease: "exclusive" | "shared";
  expires_at: string;
}

export interface WorktreeView {
  path: string;
  branch: string;
  head: string;
  dirty: number | null;
  dirty_state: "checked" | "not_checked";
  prunable: boolean;
  merged_to_main: boolean;
  behind_main?: number;
  claim?: ClaimView;
  flags: Array<"claimed" | "orphan" | "shared" | "main-dirty" | "merged-prunable" | "detached" | "behind" | "not_checked">;
}

export interface RepoView {
  repo: string;
  repo_path: string;
  worktrees: WorktreeView[];
}

export interface Alert {
  level: "info" | "warn" | "error";
  kind: string;
  subject: string;
  detail: string;
}

export interface Snapshot {
  schema_v: typeof SNAPSHOT_SCHEMA;
  as_of: string;
  duration_ms: number;
  depth: "fast" | "full";
  sources: Record<string, SourceStatus>;
  tracks: Array<Track & { lead_liveness?: Liveness | null; drift?: string[]; contending?: string[] }>;
  sessions: SessionView[];
  worktrees: { schema_v: 1; repos: RepoView[] };
  queue: { pending: number; oldest_age_ms: number | null };
  alerts: Alert[];
}

export const emptySnapshot = (asOf: string, depth: "fast" | "full" = "fast"): Snapshot => ({
  schema_v: SNAPSHOT_SCHEMA,
  as_of: asOf,
  duration_ms: 0,
  depth,
  sources: {},
  tracks: [],
  sessions: [],
  worktrees: { schema_v: 1, repos: [] },
  queue: { pending: 0, oldest_age_ms: null },
  alerts: [],
});
