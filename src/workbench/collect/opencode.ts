// dia workbench —— opencode 采集器（v2 only）
//
// 设计：docs/design/workbench.md §4.1
// 早期策略：只认 session_v2/session_message；遗留 session 表只在 migrate 时导出（有损）。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "../../redact.ts";
import type { Liveness, SessionView, SourceStatus } from "../schema.ts";

export interface CollectOpts {
  dbPath?: string;
  now?: Date;
  aliveMin?: number;
  suspectH?: number;
  hostScope?: string;
  /** 持有有效 claim 的会话（suspect 也可路由） */
  claimed?: Set<string>;
}

export interface CollectResult {
  sessions: SessionView[];
  source: SourceStatus;
  schema: "v2" | "legacy" | "absent" | "unknown";
}

const DEFAULT_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

/** opencode 的 model 列是 JSON（{id,providerID,variant}）→ 归一成 `provider/id`。 */
function modelLabel(raw: any): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw);
  try {
    const m = JSON.parse(s);
    if (m && typeof m === "object" && m.id) return `${m.providerID ? `${m.providerID}/` : ""}${m.id}`;
  } catch { /* 已经是纯字符串 */ }
  return s;
}

function livenessOf(opts: {
  lastActivity: string | null;
  suspended?: number | null;
  archived?: number | null;
  now: Date;
  aliveMin: number;
  suspectH: number;
  claimed: boolean;
}): { liveness: Liveness; resumable: boolean; delivery_ready: boolean; route_eligible: boolean; why: string } {
  const { lastActivity, suspended, archived, now, aliveMin, suspectH, claimed } = opts;
  if (archived) return { liveness: "dead", resumable: true, delivery_ready: false, route_eligible: false, why: "host: archived" };
  if (suspended) return { liveness: "dead", resumable: true, delivery_ready: false, route_eligible: false, why: "host: suspended" };
  const t = lastActivity ? Date.parse(lastActivity) : NaN;
  if (Number.isNaN(t)) {
    return { liveness: "dead", resumable: true, delivery_ready: false, route_eligible: false, why: "no activity timestamp" };
  }
  const min = (now.getTime() - t) / 60_000;
  if (min <= aliveMin) {
    return { liveness: "alive", resumable: true, delivery_ready: true, route_eligible: true, why: `last activity ${Math.round(min)}m` };
  }
  if (min <= suspectH * 60) {
    return {
      liveness: "suspect",
      resumable: true,
      delivery_ready: false,
      route_eligible: claimed,
      why: `last activity ${Math.round(min)}m${claimed ? "（持 claim）" : ""}`,
    };
  }
  return { liveness: "dead", resumable: true, delivery_ready: false, route_eligible: false, why: `last activity ${Math.round(min / 60)}h` };
}

export function collectOpencode(opts: CollectOpts = {}): CollectResult {
  const dbPath = opts.dbPath || DEFAULT_DB;
  const now = opts.now || new Date();
  const aliveMin = opts.aliveMin ?? 15;
  const suspectH = opts.suspectH ?? 12;
  const hostScope = opts.hostScope || "local";
  const claimed = opts.claimed || new Set<string>();
  const started = Date.now();

  if (!existsSync(dbPath)) {
    return { sessions: [], source: { status: "unavailable", detail: "opencode.db 不存在", duration_ms: Date.now() - started }, schema: "absent" };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((r: any) => String(r.name));
    if (!tables.includes("session_v2")) {
      const schema = tables.includes("session") ? "legacy" : "absent";
      return {
        sessions: [],
        source: {
          status: "unsupported",
          schema,
          detail: schema === "legacy" ? "只有遗留 session 表；跑 `dia wb migrate` 后需升级宿主" : "缺少 session_v2",
          duration_ms: Date.now() - started,
        },
        schema,
      };
    }
    const rows = db.prepare(
      "SELECT id,parent_id,directory,title,model,cost,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write," +
      "time_created,time_updated,time_archived,time_suspended " +
      "FROM session_v2 ORDER BY time_updated DESC",
    ).all() as any[];

    const turnRows = db.prepare("SELECT session_id, COUNT(*) AS n FROM session_message WHERE type = ? GROUP BY session_id").all("user") as any[];
    const turns = new Map<string, number>(turnRows.map((r) => [String(r.session_id), Number(r.n) || 0]));

    const sessions: SessionView[] = rows.map((r) => {
      const lastActivity = Number(r.time_updated) ? new Date(Number(r.time_updated)).toISOString() : null;
      const lv = livenessOf({
        lastActivity,
        suspended: r.time_suspended ? Number(r.time_suspended) : null,
        archived: r.time_archived ? Number(r.time_archived) : null,
        now,
        aliveMin,
        suspectH,
        claimed: claimed.has(String(r.id)),
      });
      const cost = Number(r.cost) || 0;
      const title = redact(String(r.title || ""));
      return {
        schema_v: 1,
        session_id: String(r.id),
        parent_id: r.parent_id ? String(r.parent_id) : undefined,
        host: "opencode",
        host_scope: hostScope,
        cwd: String(r.directory || ""),
        tracks: [],
        first_seen: Number(r.time_created) ? new Date(Number(r.time_created)).toISOString() : undefined,
        last_activity: lastActivity || undefined,
        last_heartbeat: null,
        liveness: lv.liveness,
        liveness_evidence: [{ source: "host", ts: lastActivity, weight: "primary", detail: lv.why }],
        resumable: lv.resumable,
        delivery_ready: lv.delivery_ready,
        route_eligible: lv.route_eligible,
        turns: turns.get(String(r.id)) || 0,
        tokens: {
          input: Number(r.tokens_input) || 0,
          output: Number(r.tokens_output) || 0,
          cache_read: Number(r.tokens_cache_read) || 0,
          cache_write: Number(r.tokens_cache_write) || 0,
        },
        cost_usd: cost > 0 ? cost : null,
        priced: cost > 0,
        models: modelLabel(r.model) ? [modelLabel(r.model)!] : [],
        title: title.text,
        raw_ref: `opencode:${r.id}`,
      } satisfies SessionView;
    });
    return {
      sessions,
      source: { status: "ok", schema: "v2", duration_ms: Date.now() - started, detail: `${rows.length} sessions` },
      schema: "v2",
    };
  } catch (e: any) {
    return {
      sessions: [],
      source: { status: "degraded", schema: "unknown", detail: (e?.message || String(e)).slice(0, 200), duration_ms: Date.now() - started },
      schema: "unknown",
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
