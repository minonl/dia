// dia collab —— 地址路由（纯逻辑 + 少量读盘）
//
// 设计：docs/design/workbench.md §7
// 地址空间：
//   session:<id>      精确会话（等价旧 `--to <id>`）
//   track:<tr>        lead（alive）→ lead（suspect 且 route_eligible）→ worker（eligible，绑定时间倒序）
//   track:<tr>/*      广播到该 track 所有 route_eligible 会话（默认只允许 notify）
//   group:<name>      显式组成员 ∩ route_eligible（默认只允许 notify）
//
// 约束：
//   · 本文件不做任何「搬文件改投」——未解析一律交给 queue.jsonl（消息不可变）
//   · 活性只认 snapshot（derived/snapshot.json）；缺失不猜 → unresolved('snapshot-missing')
//   · 写盘只发生在 groups.jsonl（collab 根内，append-only + 行数上限）

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as collab from "./collab.ts";
import * as paths from "./paths.ts";
import * as store from "./workbench/store.ts";
import type { SessionView, Track, TrackSessionRef } from "./workbench/schema.ts";

/** snapshot 超过这个年龄仍解析，但调用方应写 drift（§7：不因采集停摆而静默投错人）。 */
export const SNAPSHOT_STALE_MS = 6 * 3600_000;
/** 广播目标上限（超出视为地址写错，防一次打爆所有人）。 */
export const FANOUT_MAX = 10;

const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ── 地址解析（语法层）────────────────────────────────────────────────────────

export interface ParsedAddr {
  kind: "session" | "track" | "group";
  /** 前缀后的主体（track id / group 名 / session id） */
  body: string;
  /** `/*` 结尾的广播地址 */
  fanout: boolean;
}

/** 解析 `<kind>:<body>[/\*]`；不是路由地址（含裸 session id）返回 null。 */
export function parseAddr(addr: string | undefined): ParsedAddr | null {
  const raw = String(addr || "").trim();
  const m = /^(session|track|group):(.*)$/.exec(raw);
  if (!m) return null;
  let body = m[2].trim();
  let fanout = false;
  if (body.endsWith("/*")) { fanout = true; body = body.slice(0, -2); }
  if (!body) return null;
  return { kind: m[1] as ParsedAddr["kind"], body, fanout };
}

/** 是否应当交给路由层（`session:` 也走，用于剥前缀；裸 id 仍走旧路径）。 */
export function isRoutedAddress(addr: string | undefined): boolean {
  return parseAddr(addr) !== null;
}

// ── 上下文（tracks / snapshot / groups / handoff）────────────────────────────

export interface HandoffEntry { track: string; to: string; at: string }

export interface RouteContext {
  tracks: Track[];
  sessions: Map<string, SessionView>;
  handoffs: Map<string, HandoffEntry>;
  groups: Map<string, string[]>;
  /** snapshot.json 不存在（或损坏）时为 true */
  snapshotMissing: boolean;
  snapshotAsOf?: string;
  snapshotAgeMs?: number;
}

/** fold tracks.jsonl 的 handoff 事件，newest-wins（同一旧会话多次交接取最后一次）。 */
export function handoffIndex(): Map<string, HandoffEntry> {
  const { rows } = store.readJsonl<store.TrackEvent>(store.tracksFile());
  const map = new Map<string, HandoffEntry>();
  for (const e of rows) {
    if (!e || typeof e !== "object" || e.event !== "handoff") continue;
    if (!e.from || !e.to) continue;
    map.set(e.from, { track: e.id, to: e.to, at: e.ts });
  }
  return map;
}

/** 沿 handoff 链追到最终接手会话（S1→S2→S3 时旧地址应提示 S3）；有环则停。 */
export function handoffTarget(sessionId: string, handoffs: Map<string, HandoffEntry>): { to: string; track: string } | null {
  let cur = sessionId;
  let track = "";
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const hit = handoffs.get(cur);
    if (!hit) break;
    if (seen.has(hit.to)) break;
    seen.add(hit.to);
    track = track || hit.track;
    cur = hit.to;
  }
  return cur === sessionId ? null : { to: cur, track };
}

export function readRouteContext(opts: { now?: Date } = {}): RouteContext {
  const now = (opts.now ?? new Date()).getTime();
  const snap = store.readSnapshot();
  const { tracks } = store.foldTracks();
  const sessions = new Map<string, SessionView>();
  for (const s of snap?.sessions || []) sessions.set(s.session_id, s);
  const ageMs = snap ? store.derivedAgeMs(snap, now) : undefined;
  return {
    tracks,
    sessions,
    handoffs: handoffIndex(),
    groups: readGroups().groups,
    snapshotMissing: !snap,
    snapshotAsOf: snap?.as_of,
    snapshotAgeMs: ageMs,
  };
}

/** snapshot 年龄超过 6h：仍解析（活性可能过时），调用方写 drift。 */
export const snapshotStale = (ctx: RouteContext): boolean =>
  ctx.snapshotAgeMs !== undefined && ctx.snapshotAgeMs > SNAPSHOT_STALE_MS;

// ── 路由解析（纯逻辑）────────────────────────────────────────────────────────

export type RouteResolution =
  | { kind: "session"; to: string; why: string }
  | { kind: "fanout"; to: string[]; why: string }
  | { kind: "unresolved"; reason: string };

const aliveOrEligible = (v?: SessionView) => !!v && (v.liveness === "alive" || v.route_eligible);
const eligible = (v?: SessionView) => !!v && v.route_eligible;

/** 广播/组播前统一排序：lead 优先，其余按绑定时间倒序（老会话先接）。 */
function orderRefs(refs: TrackSessionRef[]): TrackSessionRef[] {
  return [...refs].sort((a, b) => {
    const la = a.role === "lead" ? 0 : 1;
    const lb = b.role === "lead" ? 0 : 1;
    if (la !== lb) return la - lb;
    if (b.bound_at !== a.bound_at) return b.bound_at.localeCompare(a.bound_at);
    return a.session_id.localeCompare(b.session_id);
  });
}

/**
 * 解析地址。纯函数（只读 ctx）：
 *   · 未知前缀 / track 不存在 → throw E_ROUTE_ADDR（CLI 映射 exit 2）
 *   · 广播目标超上限 → throw E_FANOUT_TOO_MANY（exit 2）
 *   · 无可用目标 → { kind:'unresolved' }（CLI 入队 + exit 40）
 */
export function resolveAddress(addr: string, ctx: RouteContext): RouteResolution {
  const p = parseAddr(addr);
  if (!p) throw new Error(`E_ROUTE_ADDR: 无法识别的地址 ${addr}（支持 session:|track:|group:）`);

  if (p.kind === "session") {
    if (p.fanout) throw new Error(`E_ROUTE_ADDR: session 地址不支持 /* 广播 ${addr}`);
    return { kind: "session", to: p.body, why: "session-exact" };
  }

  if (p.kind === "group") {
    const members = ctx.groups.get(p.body);
    if (!members) throw new Error(`E_ROUTE_ADDR: 组不存在 ${p.body}（dia collab group list 查看）`);
    if (ctx.snapshotMissing) return { kind: "unresolved", reason: "snapshot-missing" };
    const to = members.filter((sid) => eligible(ctx.sessions.get(sid)));
    if (!to.length) return { kind: "unresolved", reason: "no-route-eligible" };
    if (to.length > FANOUT_MAX) {
      throw new Error(`E_FANOUT_TOO_MANY: 组 ${p.body} 可投 ${to.length} 个会话（上限 ${FANOUT_MAX}）；缩小组成员或改用 track 地址`);
    }
    return { kind: "fanout", to, why: `group:${p.body}(${to.length})` };
  }

  // track
  const track = ctx.tracks.find((t) => t.id === p.body);
  if (!track) throw new Error(`E_ROUTE_ADDR: track 不存在 ${p.body}（dia wb track list 查看）`);
  if (ctx.snapshotMissing) return { kind: "unresolved", reason: "snapshot-missing" };

  const live = track.sessions.filter((s) => !s.unbound_at);

  if (p.fanout) {
    const to = orderRefs(live.filter((s) => eligible(ctx.sessions.get(s.session_id)))).map((s) => s.session_id);
    if (!to.length) return { kind: "unresolved", reason: "no-route-eligible" };
    if (to.length > FANOUT_MAX) {
      throw new Error(`E_FANOUT_TOO_MANY: track ${p.body} 可投 ${to.length} 个会话（上限 ${FANOUT_MAX}）`);
    }
    return { kind: "fanout", to, why: `track:${p.body}/*(${to.length})` };
  }

  const lead = live.filter((s) => s.role === "lead").sort((a, b) => b.bound_at.localeCompare(a.bound_at))[0];
  if (lead) {
    const v = ctx.sessions.get(lead.session_id);
    if (v?.liveness === "alive") return { kind: "session", to: lead.session_id, why: "lead-alive" };
    if (v?.liveness === "suspect" && v.route_eligible) return { kind: "session", to: lead.session_id, why: "lead-suspect-eligible" };
  }
  const worker = live
    .filter((s) => s !== lead)
    .sort((a, b) => b.bound_at.localeCompare(a.bound_at))
    .find((s) => aliveOrEligible(ctx.sessions.get(s.session_id)));
  if (worker) return { kind: "session", to: worker.session_id, why: "worker-eligible" };

  return { kind: "unresolved", reason: "no-route-eligible" };
}

/** 出队入口（track handoff/bind 后可调用；内部注入 resolver，避免 store ↔ route 循环依赖）。 */
export function drainRoutes(opts: { track?: string; addr?: string; max?: number; now?: Date; allowFanoutExecute?: boolean } = {}): store.DrainResult {
  const ctx = readRouteContext({ now: opts.now });
  return store.drainQueue({
    track: opts.track,
    addr: opts.addr,
    max: opts.max,
    now: opts.now,
    allowFanoutExecute: opts.allowFanoutExecute,
    resolve: (addr) => resolveAddress(addr, ctx),
  });
}

// ── 显式组：~/.dia/collab/groups.jsonl（append-only，行数上限 5000 → rotate）────

export const GROUPS_MAX_LINES = 5_000;

export interface GroupEvent { ts: string; op: "add" | "remove"; group: string; session: string }

export const groupsFile = () => join(paths.diaHome(), "collab", "groups.jsonl");

function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true, mode: 0o700 }); }

function writeAtomicLocal(file: string, data: string): void {
  ensureDir(join(file, ".."));
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readGroups(): { groups: Map<string, string[]>; rows: GroupEvent[]; bad: number } {
  const file = groupsFile();
  const groups = new Map<string, Set<string>>();
  if (!existsSync(file)) return { groups: new Map(), rows: [], bad: 0 };
  const rows: GroupEvent[] = [];
  let bad = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: GroupEvent;
    try { e = JSON.parse(line) as GroupEvent; } catch { bad++; continue; }
    if (!e?.group || !e?.session || (e.op !== "add" && e.op !== "remove")) { bad++; continue; }
    rows.push(e);
    const set = groups.get(e.group) || new Set<string>();
    if (e.op === "add") set.add(e.session); else set.delete(e.session);
    if (set.size) groups.set(e.group, set); else groups.delete(e.group);
  }
  const out = new Map<string, string[]>();
  for (const [g, set] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.set(g, [...set].sort());
  }
  return { groups: out, rows, bad };
}

function appendGroupEvent(e: GroupEvent): void {
  collab.withLock("collab-groups", () => {
    const file = groupsFile();
    const { rows, groups } = readGroups();
    ensureDir(join(file, ".."));
    if (rows.length >= GROUPS_MAX_LINES) {
      // rotate：把当前成员折叠成最少行（add-only 快照）
      const compact: GroupEvent[] = [];
      const ts = new Date().toISOString();
      for (const [group, members] of groups) {
        for (const session of members) compact.push({ ts, op: "add", group, session });
      }
      writeAtomicLocal(file, compact.map((r) => JSON.stringify(r)).join("\n") + (compact.length ? "\n" : ""));
    }
    appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 });
  });
}

function assertGroupName(name: string): string {
  const n = String(name || "").trim();
  if (!GROUP_RE.test(n) || n.includes("..")) throw new Error(`E_USAGE: 非法组名 ${n || "(empty)"}`);
  return n;
}

export function groupAdd(name: string, sessionId: string): { group: string; session: string; added: boolean } {
  const group = assertGroupName(name);
  const sid = collab.normalizeSessionId(sessionId);
  if (!collab.readSession(sid)) throw new Error(`E_SESSION_ID: 会话不存在 ${sid}（先跑 dia whoami --session ${sid}）`);
  const { groups } = readGroups();
  if ((groups.get(group) || []).includes(sid)) return { group, session: sid, added: false };
  appendGroupEvent({ ts: new Date().toISOString(), op: "add", group, session: sid });
  return { group, session: sid, added: true };
}

export function groupRemove(name: string, sessionId: string): { group: string; session: string; removed: boolean } {
  const group = assertGroupName(name);
  const sid = collab.normalizeSessionId(sessionId);
  const { groups } = readGroups();
  if (!(groups.get(group) || []).includes(sid)) {
    throw new Error(`E_GROUP_MEMBER: ${sid} 不在组 ${group} 里`);
  }
  appendGroupEvent({ ts: new Date().toISOString(), op: "remove", group, session: sid });
  return { group, session: sid, removed: true };
}

export function groupList(): Array<{ group: string; members: string[] }> {
  const { groups } = readGroups();
  return [...groups.entries()].map(([group, members]) => ({ group, members }));
}
