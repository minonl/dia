// dia workbench —— 一次性迁移探测（有损，见设计 §3.4）
//
// 只读探测：不写宿主库、不改现有 task/msg 数据。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJsonl } from "./store.ts";

export interface LegacyOpencode {
  detected: boolean;
  rows: number;
  schema: "v2" | "legacy" | "absent" | "unknown";
  detail?: string;
}

export function detectLegacyOpencode(dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db")): LegacyOpencode {
  if (!existsSync(dbPath)) return { detected: false, rows: 0, schema: "absent" };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((r: any) => String(r.name));
    if (tables.includes("session_v2")) return { detected: false, rows: 0, schema: "v2" };
    if (!tables.includes("session")) return { detected: false, rows: 0, schema: "absent" };
    const n = Number((db.prepare("SELECT COUNT(*) AS n FROM session").get() as any)?.n || 0);
    return { detected: true, rows: n, schema: "legacy" };
  } catch (e: any) {
    return { detected: false, rows: 0, schema: "unknown", detail: e?.message || String(e) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 旧 claim：缺 worktree 身份字段（toplevel_hash）的活跃租约。 */
export function countLegacyClaims(file = join(homedir(), ".dia", "collab", "claims.jsonl")): number {
  const { rows } = readJsonl<any>(file);
  const live = new Map<string, any>();
  for (const e of rows) {
    if (!e?.id) continue;
    if (e.event === "claim") live.set(e.id, e);
    if (e.event === "release") live.delete(e.id);
  }
  const now = Date.now();
  return [...live.values()].filter((c) => {
    const exp = Date.parse(String(c.expires_at || ""));
    return Number.isNaN(exp) || exp > now;
  }).filter((c) => !c.toplevel_hash).length;
}
