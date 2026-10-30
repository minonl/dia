import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DATA = process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");
export type Status = "todo" | "doing" | "blocked" | "review" | "done" | "dropped" | "awaiting_acceptance" | "accepted" | "rejected" | "escalated";

export interface Task {
  id: string;
  title: string;
  role: string;
  judge: string;
  status: Status;
  evidence: string;
  created_at: string;
  updated_at: string;
}

function file() { return join(DATA, "tasks", "ledger.jsonl"); }

function fold(): Map<string, Task> {
  const map = new Map<string, Task>();
  if (!existsSync(file())) return map;
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.event === "add") map.set(e.id, { id: e.id, title: e.title, role: e.role, judge: e.judge || "", status: "todo", evidence: "", created_at: e.ts, updated_at: e.ts });
    else {
      const t = map.get(e.id); if (!t) continue;
      if (e.status) t.status = e.status;
      if (e.evidence !== undefined) t.evidence = e.evidence;
      t.updated_at = e.ts;
    }
  }
  return map;
}

function append(e: object) {
  mkdirSync(join(DATA, "tasks"), { recursive: true });
  appendFileSync(file(), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
}

export function add(title: string, opts: { role?: string; judge?: string } = {}): Task {
  const id = "t-" + createHash("sha1").update(title + Date.now()).digest("hex").slice(0, 8);
  append({ event: "add", id, title, role: opts.role || "builder", judge: opts.judge || "" });
  return fold().get(id)!;
}

export function list(): Task[] { return [...fold().values()]; }
export function get(id: string): Task { const t = fold().get(id); if (!t) throw new Error("E_TASK: not found"); return t; }

export function status(id: string, status: Status, evidence?: string) {
  const t = get(id);
  if (status === "done") {
    if (!t.judge) throw new Error("E_TASK: judge required before done");
    if (!evidence) throw new Error("E_TASK: evidence required before done");
  }
  append({ event: "status", id, status, evidence });
  return get(id);
}
