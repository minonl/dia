// dia workbench —— collab 会话注册表采集器
//
// 身份事实源：~/.dia/collab/sessions/*.json（whoami 写）。
// 工作台只读；不把派生值写回注册表。

import { listSessions, type SessionRecord } from "../../collab.ts";
import type { Liveness, SessionView, SourceStatus } from "../schema.ts";

export interface RegistryOpts {
  now?: Date;
  aliveMin?: number;
  suspectH?: number;
  claimed?: Set<string>;
}

export interface RegistryResult {
  sessions: SessionView[];
  source: SourceStatus;
}

function livenessOf(lastSeen: string | undefined, now: Date, aliveMin: number, suspectH: number, claimed: boolean): { liveness: Liveness; delivery_ready: boolean; route_eligible: boolean; why: string } {
  const t = lastSeen ? Date.parse(lastSeen) : NaN;
  if (Number.isNaN(t)) return { liveness: "dead", delivery_ready: false, route_eligible: false, why: "no last_seen" };
  const min = (now.getTime() - t) / 60_000;
  if (min <= aliveMin) return { liveness: "alive", delivery_ready: true, route_eligible: true, why: `last_seen ${Math.round(min)}m` };
  if (min <= suspectH * 60) return { liveness: "suspect", delivery_ready: false, route_eligible: claimed, why: `last_seen ${Math.round(min)}m` };
  return { liveness: "dead", delivery_ready: false, route_eligible: false, why: `last_seen ${Math.round(min / 60)}h` };
}

/** 只补注册表独有的信息（pane/身份）；已由宿主采集到的会话由调用方合并。 */
export function collectRegistry(opts: RegistryOpts = {}): RegistryResult {
  const now = opts.now || new Date();
  const aliveMin = opts.aliveMin ?? 15;
  const suspectH = opts.suspectH ?? 12;
  const claimed = opts.claimed || new Set<string>();
  const started = Date.now();
  let recs: SessionRecord[] = [];
  try { recs = listSessions(); } catch (e: any) {
    return { sessions: [], source: { status: "degraded", detail: (e?.message || String(e)).slice(0, 160), duration_ms: Date.now() - started } };
  }
  const sessions = recs.map((r) => {
    const lv = livenessOf(r.last_seen, now, aliveMin, suspectH, claimed.has(r.session_id));
    const evidence: SessionView["liveness_evidence"] = [
      { source: "registry", ts: r.last_seen, weight: "support", detail: lv.why },
    ];
    if (r.pane) evidence.push({ source: "pane", ts: r.last_seen, weight: "support", detail: `pane ${r.pane}` });
    else evidence.push({ source: "pane", ts: null, weight: "none", detail: "no pane binding" });
    return {
      schema_v: 1,
      session_id: r.session_id,
      host: r.host || "unknown",
      host_scope: "local",
      cwd: r.cwd || "",
      tracks: [],
      first_seen: r.started_at,
      last_activity: r.last_seen,
      last_heartbeat: null,
      liveness: lv.liveness,
      liveness_evidence: evidence,
      resumable: true,
      delivery_ready: lv.delivery_ready,
      route_eligible: lv.route_eligible,
      title: r.display_name,
      raw_ref: `registry:${r.session_id}`,
    } satisfies SessionView;
  });
  return { sessions, source: { status: "ok", duration_ms: Date.now() - started, detail: `${recs.length} sessions` } };
}

/** 合并：宿主记录优先，注册表只补 cwd/显示名/证据。 */
export function mergeSessions(primary: SessionView[], registry: SessionView[]): SessionView[] {
  const byId = new Map(primary.map((s) => [s.session_id, s]));
  for (const r of registry) {
    const p = byId.get(r.session_id);
    if (!p) { byId.set(r.session_id, r); continue; }
    if (!p.cwd && r.cwd) p.cwd = r.cwd;
    if (!p.title && r.title) p.title = r.title;
    for (const e of r.liveness_evidence) {
      if (e.source === "registry" || (e.source === "pane" && e.weight !== "none")) p.liveness_evidence.push(e);
    }
  }
  return [...byId.values()];
}
