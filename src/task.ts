import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as paths from "./paths.ts";

const DATA = () => paths.diaHome();
export type Status = "todo" | "doing" | "blocked" | "review" | "done" | "dropped" | "awaiting_acceptance" | "accepted" | "rejected" | "escalated";

export interface Task {
  id: string;
  title: string;
  role: string;
  judge: string;
  status: Status;
  evidence: string;
  owner?: string;
  deps: string[];
  touches: string[];
  closure_reason?: string;
  blocked_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface AddOptions {
  role?: string;
  judge?: string;
  owner?: string;
  deps?: string[];
  touches?: string[];
}

export interface LinkOptions {
  addDeps?: string[];
  removeDeps?: string[];
  addTouches?: string[];
  removeTouches?: string[];
}

function file() { return join(DATA(), "tasks", "ledger.jsonl"); }
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

function fold(): Map<string, Task> {
  const map = new Map<string, Task>();
  if (!existsSync(file())) return map;
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.event === "add") {
      map.set(e.id, {
        id: e.id,
        title: e.title,
        role: e.role,
        judge: e.judge || "",
        status: "todo",
        evidence: "",
        owner: e.owner,
        deps: uniq(e.deps || []),
        touches: uniq(e.touches || []),
        created_at: e.ts,
        updated_at: e.ts,
      });
      continue;
    }
    const t = map.get(e.id); if (!t) continue;
    if (e.event === "link") {
      const remove = new Set([...(e.remove_deps || []), ...(e.remove_touches || [])]);
      t.deps = uniq([...t.deps, ...(e.deps || [])]).filter((x) => !remove.has(x));
      t.touches = uniq([...t.touches, ...(e.touches || [])]).filter((x) => !remove.has(x));
    } else {
      if (e.status) t.status = e.status;
      if (e.evidence !== undefined) t.evidence = e.evidence;
      if (e.closure_reason !== undefined) t.closure_reason = e.closure_reason;
      if (e.blocked_reason !== undefined) t.blocked_reason = e.blocked_reason;
    }
    t.updated_at = e.ts;
  }
  return map;
}

function append(e: object) {
  mkdirSync(join(DATA(), "tasks"), { recursive: true });
  appendFileSync(file(), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
}

export function add(title: string, opts: AddOptions = {}): Task {
  const id = "t-" + createHash("sha1").update(title + Date.now()).digest("hex").slice(0, 8);
  append({
    event: "add", id, title, role: opts.role || "builder", judge: opts.judge || "",
    owner: opts.owner, deps: uniq(opts.deps || []), touches: uniq(opts.touches || []),
  });
  return fold().get(id)!;
}

export function list(): Task[] { return [...fold().values()]; }
export function get(id: string): Task { const t = fold().get(id); if (!t) throw new Error("E_TASK: not found"); return t; }

export function link(id: string, opts: LinkOptions): Task {
  const t = get(id);
  const removeDeps = uniq(opts.removeDeps || []);
  const removeTouches = uniq(opts.removeTouches || []);
  for (const d of removeDeps) if (!t.deps.includes(d)) throw new Error(`E_TASK: ${id} 未依赖 ${d}`);
  for (const p of removeTouches) if (!t.touches.includes(p)) throw new Error(`E_TASK: ${id} 未声明路径 ${p}`);
  append({
    event: "link", id,
    deps: uniq(opts.addDeps || []).filter((d) => !removeDeps.includes(d)),
    touches: uniq(opts.addTouches || []).filter((p) => !removeTouches.includes(p)),
    remove_deps: removeDeps, remove_touches: removeTouches,
  });
  return get(id);
}

export function status(id: string, status: Status, evidence?: string, opts: { closureReason?: string; blockedReason?: string } = {}) {
  const t = get(id);
  if (status === "done") {
    if (!t.judge) throw new Error("E_TASK: judge required before done");
    if (!evidence) throw new Error("E_TASK: evidence required before done");
  }
  append({ event: "status", id, status, evidence, closure_reason: opts.closureReason, blocked_reason: opts.blockedReason });
  return get(id);
}
