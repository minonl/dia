// dia workbench —— 快照组装（M0 意图层 + M1 采集结果注入）
//
// 设计：docs/design/workbench.md §3 / §9.2
// 约定：同一 --now 下输出必须字节可比（duration_ms 由调用方填）。

import { emptySnapshot, SNAPSHOT_SCHEMA, type Alert, type Snapshot, type Track } from "./schema.ts";
import * as store from "./store.ts";

export interface BuildOpts {
  now?: Date;
  depth?: "fast" | "full";
  /** 采集器结果（M1 注入）；缺省表示本阶段未采集。 */
  sessions?: Snapshot["sessions"];
  worktrees?: Snapshot["worktrees"];
  sources?: Snapshot["sources"];
  alerts?: Alert[];
}

function trackAlerts(tracks: Track[]): Alert[] {
  const out: Alert[] = [];
  for (const t of tracks) {
    if (["done", "abandoned"].includes(t.status)) continue;
    const leads = t.sessions.filter((s) => s.role === "lead" && !s.unbound_at);
    if (!leads.length) out.push({ level: "warn", kind: "track-no-lead", subject: t.id, detail: `${t.title} 没有活跃 lead` });
    if (leads.length > 1) out.push({ level: "error", kind: "track-ambiguous", subject: t.id, detail: `${t.title} 有 ${leads.length} 个 lead` });
    if (!t.next) out.push({ level: "info", kind: "track-no-next", subject: t.id, detail: `${t.title} 未登记下一步` });
  }
  return out;
}

export function buildSnapshot(opts: BuildOpts = {}): Snapshot {
  const now = opts.now || new Date();
  const s = emptySnapshot(now.toISOString(), opts.depth || "fast");
  const { tracks, bad } = store.foldTracks();
  const { rows: drift } = store.readDrift();
  const { rows: queue, bad: badQueue } = store.readQueue();

  s.schema_v = SNAPSHOT_SCHEMA;
  s.sources = opts.sources || { workbench: { status: "ok", detail: "intent-only（未采集；跑 `dia wb refresh`）" } };
  s.sessions = opts.sessions || [];
  s.worktrees = opts.worktrees || { schema_v: 1, repos: [] };
  s.queue = {
    pending: queue.filter((q) => !q.resolved_at).length,
    oldest_age_ms: (() => {
      const ts = queue.filter((q) => !q.resolved_at).map((q) => Date.parse(q.created_at)).filter((n) => !Number.isNaN(n));
      return ts.length ? Math.max(0, now.getTime() - Math.min(...ts)) : null;
    })(),
  };
  s.alerts = [...(opts.alerts || []), ...trackAlerts(tracks)];
  if (bad) s.alerts.push({ level: "warn", kind: "tracks-corrupt", subject: "tracks.jsonl", detail: `${bad} 行无法解析` });
  if (badQueue) s.alerts.push({ level: "warn", kind: "queue-corrupt", subject: "queue.jsonl", detail: `${badQueue} 行无法解析` });

  s.tracks = tracks.map((t) => {
    const lead = t.sessions.filter((x) => x.role === "lead" && !x.unbound_at).sort((a, b) => b.bound_at.localeCompare(a.bound_at))[0];
    const leadSession = lead ? s.sessions.find((x) => x.session_id === lead.session_id) : undefined;
    return {
      ...t,
      lead_liveness: leadSession ? leadSession.liveness : null,
      drift: drift.filter((d) => d.track === t.id).map((d) => `${d.kind}: ${d.detail}`),
      contending: [],
    };
  });
  for (const d of drift) {
    const already = s.alerts.some((a) => a.kind === d.kind && a.subject === (d.track || d.subject));
    if (!already) s.alerts.push({ level: "warn", kind: d.kind, subject: d.track || d.subject, detail: d.detail });
  }
  return s;
}

export function snapshotText(s: Snapshot): string {
  const active = {
    open: s.tracks.filter((t) => t.status === "open").length,
    active: s.tracks.filter((t) => t.status === "active").length,
    paused: s.tracks.filter((t) => t.status === "paused").length,
    blocked: s.tracks.filter((t) => t.status === "blocked").length,
    awaiting_human: s.tracks.filter((t) => t.status === "awaiting_human").length,
  };
  const lines: string[] = [];
  const age = Math.max(0, Date.now() - Date.parse(s.as_of));
  lines.push(`as_of ${isNaNAge(age) ? "?" : humanAge(age)}  depth ${s.depth}  ${s.duration_ms ? `took ${s.duration_ms}ms` : ""}`.trimEnd());
  lines.push(`sources ${Object.entries(s.sources).map(([k, v]) => `${k}:${v.status}`).join(" · ") || "(none)"}`);
  lines.push(
    `TRACKS  ${active.active} active · ${active.paused} paused · ${active.blocked} blocked · ${active.awaiting_human} awaiting_human · ${active.open} open`,
  );
  if (!s.tracks.length) lines.push("  (none —— dia wb track open \"<title>\" --repo <group/repo>)");
  for (const t of s.tracks) {
    const lead = t.sessions.filter((x) => x.role === "lead" && !x.unbound_at).slice(-1)[0];
    const lv = t.lead_liveness ? ` ${t.lead_liveness === "alive" ? "✔" : t.lead_liveness === "suspect" ? "◐" : "✖"}` : "";
    lines.push(
      `${t.id}  ${t.prio} ${t.status.padEnd(14)} ${t.title}` +
        (t.next ? `   next:${t.next}` : "") +
        (lead ? `   lead@${lead.host}:${lead.session_id.slice(-4)}${lv}` : "   lead:-"),
    );
  }

  const alive = s.sessions.filter((x) => x.liveness === "alive").length;
  const suspect = s.sessions.filter((x) => x.liveness === "suspect").length;
  const dead = s.sessions.filter((x) => x.liveness === "dead").length;
  const deadResumable = s.sessions.filter((x) => x.liveness === "dead" && x.resumable).length;
  const trackless = s.sessions.filter((x) => !x.tracks.length).length;
  lines.push(
    `SESSIONS ${alive} alive · ${suspect} suspect · ${dead} dead${deadResumable ? `(${deadResumable} resumable)` : ""} · ${trackless} 无 track`,
  );

  const wts = s.worktrees.repos.flatMap((r) => r.worktrees);
  const flag = (f: string) => wts.filter((w) => (w.flags as string[]).includes(f)).length;
  lines.push(
    `ORPHANS  wt: ${flag("orphan")} unclaimed · ${flag("shared")} shared · ${flag("main-dirty")} main-dirty · ${flag("not_checked")} not_checked · ${flag("merged-prunable")} prunable` +
      `  (${s.worktrees.repos.length} repos / ${wts.length} wts)`,
  );
  lines.push(`ALERTS   ${s.alerts.length}`);
  for (const a of s.alerts.slice(0, 8)) lines.push(`  [${a.level}] ${a.kind} ${a.subject}: ${a.detail}`);
  if (s.queue.pending) lines.push(`QUEUE    ${s.queue.pending} 条未投递`);
  return lines.join("\n");
}

function isNaNAge(n: number): boolean {
  return Number.isNaN(n) || !Number.isFinite(n);
}

/** 快照年龄：秒 → 分 → 时（设计 §9.2 的 `as_of 12s ago`）。 */
function humanAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
