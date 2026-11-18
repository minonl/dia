// dia wb —— 任务工作台 CLI（M0 读路径/契约/迁移 + M1 采集落盘）
//
// 设计：docs/design/workbench.md §3 / §9
// 约定：`dia wb` 只读快照（无快照时只装意图层，不采集）；`dia wb refresh` 才采集写盘；
//       `--now` 可注入用于判据；`--json --summary` 只出计数（全量快照已 >1MB）。

import { writeSync } from "node:fs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as collab from "../../../src/collab.ts";
import { buildSnapshot, snapshotText } from "../../../src/workbench/snapshot.ts";
import { collectAll } from "../../../src/workbench/collect/index.ts";
import * as store from "../../../src/workbench/store.ts";
import * as paths from "../../../src/paths.ts";
import * as taskLedger from "../../../src/task.ts";
import * as claims from "../../../src/claims.ts";
import { loadPrices } from "../../../src/pricing.ts";
import { buildMetrics, type MetricRun, type MetricSession } from "../../../src/workbench/metrics.ts";
import { computeDue } from "../../../src/workbench/due.ts";
import { detectLegacyOpencode, countLegacyClaims } from "../../../src/workbench/migrate.ts";
import { loadConfig } from "../../../src/workbench/config.ts";
import { wbTrackCli } from "./wb-track-cli.ts";
import type { Snapshot } from "../../../src/workbench/schema.ts";

const out = (s: string) => writeStdout(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

/** 同步写 stdout：全量 snapshot --json 已 >1MB，异步写 + 进程 exit 会把管道输出截断在 128KB。 */
function writeStdout(text: string) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  let guard = 0;
  while (off < buf.length && guard < 10_000) {
    guard++;
    try {
      off += writeSync(1, buf, off);
    } catch (e: any) {
      if (e?.code === "EAGAIN") continue;
      break; // 其他错误（如管道提前关闭）交给上层；不静默改写数据
    }
  }
  if (off < buf.length) process.stdout.write(buf.subarray(off));
}

function has(argv: string[], name: string): boolean { return argv.includes(name); }
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const VALUE_FLAGS = new Set([
  "--now", "--depth", "--port", "--track", "--session", "--since", "--status", "--limit", "--interval",
  "--repo", "--goal", "--prio", "--owner", "--next", "--stage", "--remind-at",
  "--role", "--host", "--reason", "--set", "--waiting-on", "--from", "--to", "--task", "--id", "--explain",
]);
function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { if (!argv[i].includes("=") && VALUE_FLAGS.has(argv[i])) i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

function parseNow(argv: string[]): Date | null | undefined {
  const raw = flag(argv, "--now");
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 读视图：意图（tracks/alerts/queue）实时折叠，派生（sessions/worktrees）用缓存快照。
 *  track open/close 后无需 refresh 就能在 board 看到最新意图（2026-11-18 实测：close 后仍显示 active）。 */
function readView(now: Date | undefined, depth: "fast" | "full"): Snapshot {
  const cached = store.readSnapshot();
  if (!cached) return buildSnapshot({ now, depth });
  const s = buildSnapshot({ now, depth, sessions: cached.sessions, worktrees: cached.worktrees, sources: cached.sources });
  s.as_of = cached.as_of;
  s.duration_ms = cached.duration_ms;
  return s;
}

function render(s: Snapshot, asJson: boolean, summary = false) {
  if (asJson) out(JSON.stringify(summary ? summarize(s) : s, null, 1));
  else out(snapshotText(s));
  if (s.alerts.some((a) => a.level === "error")) process.exitCode = 1;
}

/** `--json --summary`：只出计数与 track 概要（不输出 sessions/worktrees 明细，避免 1MB+ 输出）。 */
function summarize(s: Snapshot) {
  const count = <T>(xs: T[], pred: (x: T) => boolean) => xs.filter(pred).length;
  const wts = s.worktrees.repos.flatMap((r) => r.worktrees);
  const flag = (f: string) => count(wts, (w) => (w.flags as string[]).includes(f));
  return {
    schema_v: s.schema_v,
    as_of: s.as_of,
    duration_ms: s.duration_ms,
    depth: s.depth,
    sources: s.sources,
    counts: {
      tracks: {
        open: count(s.tracks, (t) => t.status === "open"),
        active: count(s.tracks, (t) => t.status === "active"),
        paused: count(s.tracks, (t) => t.status === "paused"),
        blocked: count(s.tracks, (t) => t.status === "blocked"),
        awaiting_human: count(s.tracks, (t) => t.status === "awaiting_human"),
        done: count(s.tracks, (t) => t.status === "done"),
        abandoned: count(s.tracks, (t) => t.status === "abandoned"),
      },
      sessions: {
        total: s.sessions.length,
        alive: count(s.sessions, (x) => x.liveness === "alive"),
        suspect: count(s.sessions, (x) => x.liveness === "suspect"),
        dead: count(s.sessions, (x) => x.liveness === "dead"),
        dead_resumable: count(s.sessions, (x) => x.liveness === "dead" && x.resumable),
        trackless: count(s.sessions, (x) => !x.tracks.length),
      },
      worktrees: {
        repos: s.worktrees.repos.length,
        total: wts.length,
        claimed: flag("claimed"),
        orphan: flag("orphan"),
        shared: flag("shared"),
        main_dirty: flag("main-dirty"),
        not_checked: flag("not_checked"),
        prunable: flag("merged-prunable"),
        detached: flag("detached"),
      },
    },
    queue: s.queue,
    tracks: s.tracks.map((t) => {
      const lead = t.sessions.filter((x) => x.role === "lead" && !x.unbound_at).slice(-1)[0];
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        prio: t.prio,
        stage: t.stage,
        next: t.next,
        waiting_on: t.waiting_on,
        remind_at: t.remind_at,
        repo: t.repo,
        lead: lead ? { session_id: lead.session_id, host: lead.host, liveness: t.lead_liveness || null } : null,
        drift: t.drift || [],
      };
    }),
    alerts: s.alerts,
  };
}

/** 读 `~/.dia/runs/<task>/run.json + usage.json` → MetricRun[]（只取角色与 mock 标记）。 */
function loadRuns(): MetricRun[] {
  const root = paths.runsDir();
  if (!existsSync(root)) return [];
  const rows: MetricRun[] = [];
  for (const id of readdirSync(root)) {
    const rp = join(root, id, "run.json");
    if (!existsSync(rp)) continue;
    let r: any = {};
    try { r = JSON.parse(readFileSync(rp, "utf8")); } catch { continue; }
    let roles: string[] = [];
    try {
      const u = JSON.parse(readFileSync(join(root, id, "usage.json"), "utf8"));
      if (Array.isArray(u?.by_role)) roles = u.by_role.map((x: any) => (typeof x === "string" ? x : String(x?.role || ""))).filter(Boolean);
      else if (u?.by_role && typeof u.by_role === "object") roles = Object.keys(u.by_role);
    } catch { /* 无 usage 也要保留 run 的 mock 语义 */ }
    if (!roles.length) roles = ["unknown"];
    for (const role of roles) rows.push({ id, role, mock: !!r.mock, track: r.track });
  }
  return rows;
}

function toMetricSessions(s: Snapshot): MetricSession[] {
  return s.sessions.map((x) => ({
    session_id: x.session_id,
    parent_id: x.parent_id,
    host: x.host,
    tokens: x.tokens,
    cost_usd: x.cost_usd ?? undefined,
    models: x.models,
    turns: x.turns,
    tools: x.tools,
    tool_errors: x.tool_errors,
    first_seen: x.first_seen,
    last_activity: x.last_activity,
    tracks: x.tracks,
  }));
}

function parseSince(raw?: string): Date | null | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^(\d+)([dhw])$/);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 7 * 86_400_000;
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function renderMetrics(m: ReturnType<typeof buildMetrics>): string {
  const lines: string[] = [];
  lines.push(`as_of ${m.as_of}  window ${m.window.since || "-"} → ${m.window.until}${m.window.approximate ? "（近似）" : ""}`);
  lines.push(`mode ${m.mode}  goal_type ${m.goal_type}  n.tracks ${m.n.tracks} / sessions ${m.n.sessions}（root ${m.n.parents} + sub ${m.n.subagents}）`);
  lines.push(`tokens in ${m.tokens.input} · out ${m.tokens.output} · cache_read ${m.tokens.cache_read} · total ${m.tokens.total}`);
  lines.push(`cost ${m.cost_usd === null ? "unpriced" : `$${m.cost_usd.toFixed(4)}`}（basis ${m.cost_basis}）`);
  lines.push(`turns ${m.turns} · tools ${m.tools.total}（失败 ${m.tools.errors}，${(m.tools.failure_rate * 100).toFixed(1)}%）· active ${(m.active_ms / 60_000).toFixed(1)}min · wall ${(m.wall_ms / 60_000).toFixed(1)}min`);
  lines.push(`acceptance ${m.acceptance.done}/${m.acceptance.attempted}${m.acceptance.rate === null ? "" : `（${(m.acceptance.rate * 100).toFixed(0)}%）`} · judge 覆盖 ${(m.acceptance.judge_coverage * 100).toFixed(0)}% · rework ${m.rework.rounds}`);
  if (m.compare) {
    lines.push(`compare ${m.compare.goal_type}: n=${m.compare.n}${m.compare.conclusive ? ` → ${m.compare.verdict}` : `（还需 ${m.compare.need_more} 个样本）`}`);
  }
  lines.push(`footnote: ${m.footnote}`);
  return lines.join("\n");
}

function renderDue(r: ReturnType<typeof computeDue>): string {
  const lines: string[] = [];
  lines.push(`DUE ${r.counts.total}（超期 ${r.counts.overdue} · remind ${r.counts.remind} · 无 lead ${r.counts.no_lead} · blocked ${r.counts.blocked}）  tz ${r.assumed_tz}`);
  for (const it of r.items.slice(0, 10)) {
    const why = it.reasons.map((x) => x.kind).join(",");
    lines.push(`${it.track_id}  ${it.prio} ${it.status}  ${it.title}   [${why}]${it.overdue_ms ? ` 超期 ${(it.overdue_ms / 3_600_000).toFixed(1)}h` : ""}`);
    if (it.next) lines.push(`   next: ${it.next}`);
    for (const a of it.next_actions.slice(0, 2)) lines.push(`   → ${a}`);
  }
  if (!r.items.length) lines.push("(none)");
  return lines.join("\n");
}

/** `dia beat`：会话心跳（只作活性佐证，不是唯一依据）。 */
export function beatCli(argv: string[]): number {
  if (has(argv, "--help") || has(argv, "-h")) {
    out(`usage: dia beat [--session S] [--track ID] [--note TEXT] [--json]

写入一行会话心跳（workbench/beats.jsonl，ephemeral，TTL 720h）。
会话标识取 --session > DIA_SESSION_ID > OPENCODE_SESSION_ID；--help 只打印用法、不写盘。`);
    return 0;
  }
  let session = flag(argv, "--session");
  if (!session) {
    try { session = collab.resolveSessionId(undefined); } catch { /* 下面统一报错 */ }
  }
  if (!session) { err("E_NO_SESSION: 未找到会话标识（--session / DIA_SESSION_ID / OPENCODE_SESSION_ID）"); return 2; }
  const trackId = flag(argv, "--track");
  const host = process.env.OPENCODE_SESSION_ID ? "opencode" : "cli";
  const ts = new Date().toISOString();
  try {
    store.appendBeat({ ts, session, host, cwd: process.cwd(), track: trackId, note: flag(argv, "--note") });
  } catch (e: any) {
    err(`E_WB_BEAT: ${e?.message || e}`);
    return 1;
  }
  if (has(argv, "--json")) out(JSON.stringify({ ok: true, session, track: trackId || null, ts }));
  else out(`beat ${session}${trackId ? ` track=${trackId}` : ""}`);
  return 0;
}

export function wbCli(argv: string[]): number {  const sub = positional(argv)[0];
  const asJson = has(argv, "--json");
  const summary = has(argv, "--summary");
  const depth = (flag(argv, "--depth") === "full" ? "full" : "fast") as "fast" | "full";
  const now = parseNow(argv);
  if (now === null) { err("E_WB: --now 不是合法时间（ISO）"); return 2; }

  if (sub === "track") return wbTrackCli(argv.slice(1));

  if (sub === "metrics") {
    const since = parseSince(flag(argv, "--since"));
    if (since === null) { err("E_WB_SINCE: --since 支持 7d / 24h / 4w / ISO"); return 2; }
    const snap = readView(now || undefined, depth);
    const wanted = flag(argv, "--track");
    let tracks = snap.tracks as any[];
    let tasks = taskLedger.list();
    let sessions = snap.sessions;
    if (wanted) {
      const t = tracks.find((x) => x.id === wanted);
      if (!t) { err(`E_WB_NOT_FOUND: ${wanted}`); return 2; }
      tracks = [t];
      tasks = tasks.filter((x) => (t.tasks || []).includes(x.id));
      sessions = sessions.filter((x) => x.tracks.includes(wanted));
    }
    const m = buildMetrics({
      as_of: now ? now.toISOString() : snap.as_of,
      window: since ? { since: since.toISOString(), until: (now || new Date()).toISOString() } : { since: null, until: (now || new Date()).toISOString() },
      sessions: toMetricSessions({ ...snap, sessions }),
      tracks,
      tasks: tasks.map((x) => ({ id: x.id, status: x.status, judge: x.judge })),
      runs: loadRuns(),
      prices: loadPrices(),
    });
    if (asJson) out(JSON.stringify(m, null, 1));
    else out(renderMetrics(m));
    return 0;
  }

  if (sub === "due" || sub === "brief") {
    const snap = readView(now || undefined, depth);
    const claimCounts = new Map<string, number>();
    try { for (const c of claims.list({})) claimCounts.set(c.holder, (claimCounts.get(c.holder) || 0) + 1); } catch { /* 无 claims 也要能跑 */ }
    const { rows: beats } = store.readBeats();
    const r = computeDue({
      tracks: snap.tracks as any,
      sessions: snap.sessions.map((x) => ({
        session_id: x.session_id,
        liveness: x.liveness,
        last_activity: x.last_activity,
        last_heartbeat: x.last_heartbeat,
        claims: claimCounts.get(x.session_id) || 0,
      })),
      beats: beats.map((b) => ({ session: b.session, ts: b.ts })),
      now: now || new Date(),
    });
    if (sub === "brief") {
      if (asJson) out(JSON.stringify({ schema_v: 1, ...r.brief }, null, 1));
      else {
        out(r.brief.head);
        for (const it of r.brief.items) out(`  ${it.track_id}  ${it.title}${it.overdue_ms ? `（超期 ${(it.overdue_ms / 3_600_000).toFixed(1)}h）` : ""}`);
        for (const a of r.brief.next_actions) out(`  → ${a}`);
      }
      return 0; // 开工自检不让脚本失败
    }
    if (asJson) out(JSON.stringify(r, null, 1));
    else out(renderDue(r));
    return r.items.length ? 1 : 0;
  }

  if (sub === "migrate") {
    const dry = has(argv, "--dry-run");
    try {
      const legacy = detectLegacyOpencode();
      const legacyClaims = countLegacyClaims();
      const r = store.migrateWorkbench({ dryRun: dry });
      r.legacy_opencode = { detected: legacy.detected, rows: legacy.rows };
      r.legacy_claims = legacyClaims;
      if (asJson) out(JSON.stringify({ schema_v: 1, ...r, opencode_schema: legacy.schema, config: loadConfig().source }, null, 1));
      else {
        out(`migrate workbench${dry ? "（dry-run）" : ""}`);
        out(`  opencode schema: ${legacy.schema}（遗留表 ${legacy.rows} 行${legacy.detected ? "，将导出后丢弃明细" : ""}）`);
        out(`  旧 claim: ${legacyClaims} 条`);
        out(`  derived/: ${r.derived_present ? (dry ? "将删除重建" : "已删除重建") : "不存在"}`);
        out(`  config.json: ${loadConfig().source === "file" ? "已存在" : dry ? "将写入默认白名单" : "已写入默认白名单"}`);
        for (const w of r.written || []) out(`  written: ${w}`);
      }
      return 0;
    } catch (e: any) { err(`E_WB_MIGRATE: ${e?.message || e}`); return 1; }
  }

  if (sub === "gc") {
    const apply = has(argv, "--apply");
    try {
      const r = store.gcWorkbench({ dryRun: !apply, now: now || undefined });
      if (asJson) out(JSON.stringify(r, null, 1));
      else {
        out(`gc workbench${r.dry_run ? "（dry-run，加 --apply 执行）" : ""}`);
        out(`  kept ${r.kept} · removed ${r.removed.length} · rotated ${r.rotated.length} · reclaimed ${(r.reclaimed_bytes / 1024).toFixed(1)}KB`);
        for (const x of r.removed.slice(0, 20)) out(`  - ${x.path}（${x.reason}，${x.bytes}B）`);
        if (r.removed.length > 20) out(`  … 另有 ${r.removed.length - 20} 条`);
        for (const x of r.rotated) out(`  ~ ${x.path}（${x.reason}）`);
        for (const s of r.skipped) out(`  ! ${s.path}：${s.reason}`);
        out(`  quota ${(r.quota.bytes / 1024 / 1024).toFixed(1)}MB / ${(r.quota.limit / 1024 / 1024).toFixed(0)}MB${r.quota.over ? " 超限" : r.quota.warn ? " 接近上限" : ""}`);
      }
      return r.quota.over && !r.dry_run ? 1 : 0;
    } catch (e: any) { err(`E_WB_GC: ${e?.message || e}`); return 1; }
  }

  if (sub === "refresh") {
    const started = Date.now();
    const { tracks } = store.foldTracks();
    const c = collectAll({
      now: now || undefined,
      depth,
      tracks,
      opencodeDbPath: process.env.DIA_WB_OPENCODE_DB || undefined,
    });
    const s = buildSnapshot({
      now: now || undefined,
      depth,
      sessions: c.sessions,
      worktrees: c.worktrees,
      sources: c.sources,
      alerts: c.alerts,
    });
    s.duration_ms = Date.now() - started;
    try { store.writeSnapshot(s); } catch (e: any) { err(`E_WB_WRITE: ${e?.message || e}`); return 1; }
    // 只对 ephemeral 做自动收敛；durable 永不自动删（白名单约束）
    try { store.gcWorkbench({ dryRun: false, now: now || undefined, ephemeralOnly: true }); } catch { /* best-effort */ }
    render(s, asJson, summary);
    return 0;
  }

  if (sub === "orphans") {
    const s = readView(now || undefined, depth);
    const all = has(argv, "--all");
    const rows = s.worktrees.repos.flatMap((r) => r.worktrees.map((w) => ({ repo: r.repo, repo_path: r.repo_path, ...w })));
    const picked = all ? rows : rows.filter((w) => ["orphan", "shared", "main-dirty"].some((f) => (w.flags as string[]).includes(f)));
    if (asJson) out(JSON.stringify({ schema_v: 1, as_of: s.as_of, count: picked.length, worktrees: picked }, null, 1));
    else if (!picked.length) out("(none)");
    else for (const w of picked) out(`${w.repo}  ${w.path}  [${w.flags.join(",")}]${w.claim ? `  claim=${w.claim.id}(${w.claim.holder})` : ""}`);
    return 0;
  }

  if (sub === "explain") {
    const id = positional(argv)[1] || flag(argv, "--explain");
    if (!id) { err("usage: dia wb explain <tr-id|session-id>"); return 2; }
    const s = readView(now || undefined, depth);
    const t = s.tracks.find((x) => x.id === id);
    const sess = s.sessions.find((x) => x.session_id === id);
    if (!t && !sess) { err(`E_WB_NOT_FOUND: ${id}`); return 1; }
    const body = t ? { track: t } : { session: sess };
    if (asJson) out(JSON.stringify(body, null, 1));
    else out(JSON.stringify(body, null, 1));
    return 0;
  }

  // 默认：只读。无快照时即时构建（不落盘），保证空数据根也能用。
  if (has(argv, "--watch")) {
    const sec = Math.max(1, Number(flag(argv, "--interval") || 5) || 5);
    const loop = () => {
      const started = Date.now();
      const { tracks } = store.foldTracks();
      const c = collectAll({ now: new Date(), depth, tracks, opencodeDbPath: process.env.DIA_WB_OPENCODE_DB || undefined });
      const snap = buildSnapshot({ depth, sessions: c.sessions, worktrees: c.worktrees, sources: c.sources, alerts: c.alerts });
      snap.duration_ms = Date.now() - started;
      try { store.writeSnapshot(snap); } catch { /* 只读循环不因写盘失败中断 */ }
      if (asJson) out(JSON.stringify(summary ? summarize(snap) : snap, null, 1));
      else out(`\x1b[2J\x1b[H` + snapshotText(snap));
    };
    loop();
    for (;;) {
      // 前台阻塞轮询：无常驻守护，Ctrl-C 结束（设计 §9.2）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000);
      loop();
    }
  }
  const s = readView(now || undefined, depth);
  render(s, asJson, summary);
  return 0;
}
