import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { countCalls, lastCall } from "./runtime.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import * as paths from "./paths.ts";

const STATE = paths.stateDir();
const FILE = join(STATE, "freeze.json");

export interface FreezeState {
  frozen: boolean;
  reason?: string;
  since?: string;
  by?: "human" | "auto";
  last_episode?: string;
  last_run?: string;
  last_tool?: string;
  last_exit?: number;
  completed_runs?: number;
  cwd?: string;
  session?: string;
}

export function status(): FreezeState {
  if (!existsSync(FILE)) return { frozen: false };
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    if (!s || typeof s.frozen !== "boolean") throw new Error("bad shape");
    return s;
  } catch {
    // fail-closed: 状态损坏不等于未冻结
    return { frozen: true, reason: "freeze state corrupted; failing closed", since: new Date().toISOString(), by: "auto" };
  }
}

export function freeze(opts: { reason: string; by?: "human" | "auto"; lastEpisode?: string; session?: string }) {
  mkdirSync(STATE, { recursive: true });
  const cur = status();
  if (cur.frozen) return cur;
  const lc = opts.session ? lastCall(opts.session) : null;
  const next: FreezeState = {
    frozen: true,
    reason: opts.reason,
    since: new Date().toISOString(),
    by: opts.by || "human",
    last_episode: opts.lastEpisode,
    last_run: lc?.run_id,
    last_tool: lc?.tool,
    last_exit: lc?.exit,
    completed_runs: opts.session ? countCalls(opts.session) : undefined,
    cwd: lc?.cwd,
    session: opts.session,
  };
  writeFileSync(FILE, JSON.stringify(next, null, 1), { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch {}
  try { writeFileSync(join(STATE, "freeze-snapshot.json"), JSON.stringify({
    ts: next.since, reason: next.reason, last_episode: next.last_episode,
    last_run: next.last_run, last_tool: next.last_tool, last_exit: next.last_exit,
    completed_runs: next.completed_runs, cwd: next.cwd, session: next.session,
  }, null, 1), { mode: 0o600 }); } catch {}
  return next;
}

export function thaw(opts: { reason: string; human: boolean }) {
  if (!opts.human) throw new Error("thaw requires human confirmation (--i-am-human); agent-side thaw is refused");
  if (!opts.reason || !opts.reason.trim()) throw new Error("thaw requires --reason");
  const cur = status();
  if (!cur.frozen) return { ...cur, thawed: false };
  mkdirSync(STATE, { recursive: true });
  const next = { frozen: false, reason: `thawed: ${opts.reason}`, since: new Date().toISOString(), by: "human" as const, last_episode: cur.last_episode };
  writeFileSync(FILE, JSON.stringify(next, null, 1), { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch {}
  return { ...next, thawed: true };
}

export function snapshot() {
  const p = join(STATE, "freeze-snapshot.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function stateFile() { return FILE; }
export function stateMode() { try { return (statSync(FILE).mode & 0o777).toString(8); } catch { return null; } }
