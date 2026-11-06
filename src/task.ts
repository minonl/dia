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
  /** 计划优先级 P0–P99（与 status 正交） */
  prio?: string;
  /** 计划开始日 YYYY-MM-DD（本地日）；缺失时展示层回填 created_at */
  start?: string;
  /** 计划结束/截止日 YYYY-MM-DD；缺失时未完成画开放端 */
  due?: string;
  /** 人工进度 0–100；缺失时展示层按 status 派生（标注估算） */
  progress?: number;
  /** 进入 done/accepted 的时间（派生字段，不单独入账） */
  closed_at?: string;
}

export interface AddOptions {
  role?: string;
  judge?: string;
  owner?: string;
  deps?: string[];
  touches?: string[];
  prio?: string;
  start?: string;
  due?: string;
  progress?: number;
}

export interface PlanOptions {
  prio?: string;
  start?: string;
  due?: string;
  progress?: number;
}

const PRIO_RE = /^P\d{1,2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normPrio(v: string): string {
  const s = String(v).trim().toUpperCase();
  if (!PRIO_RE.test(s)) throw new Error(`E_TASK: prio 必须是 P0–P99（收到 ${v}）`);
  return s;
}
export function normDay(v: string): string {
  const s = String(v).trim();
  if (DAY_RE.test(s)) {
    const [y, mo, d] = s.split("-").map(Number);
    const dt = new Date(y, mo - 1, d); // 本地日校验，禁止 toISOString（会把 +08:00 的午夜折回前一天）
    if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) return s;
  }
  throw new Error(`E_TASK: 日期必须是有效 YYYY-MM-DD（收到 ${v}）`);
}
export function normProgress(v: number | string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`E_TASK: progress 必须是 0–100 的整数（收到 ${v}）`);
  return n;
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
        ...readPlan(e),
      });
      continue;
    }
    const t = map.get(e.id); if (!t) continue;
    if (e.event === "link") {
      const remove = new Set([...(e.remove_deps || []), ...(e.remove_touches || [])]);
      t.deps = uniq([...t.deps, ...(e.deps || [])]).filter((x) => !remove.has(x));
      t.touches = uniq([...t.touches, ...(e.touches || [])]).filter((x) => !remove.has(x));
    } else if (e.event === "plan") {
      // 计划态单独分支：只覆盖出现的字段，不碰 status/evidence
      Object.assign(t, readPlan(e));
    } else {
      if (e.status) {
        t.status = e.status;
        if (e.status === "done" || e.status === "accepted") t.closed_at = t.closed_at || e.ts;
        else t.closed_at = undefined;
      }
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
    ...planFields(opts),
  });
  return fold().get(id)!;
}

function planFields(o: PlanOptions): Partial<Task> {
  const out: Partial<Task> = {};
  if (o.prio !== undefined) out.prio = normPrio(o.prio);
  if (o.start !== undefined) out.start = normDay(o.start);
  if (o.due !== undefined) out.due = normDay(o.due);
  if (o.progress !== undefined) out.progress = normProgress(o.progress);
  return out;
}

/** 读取账本里的计划字段；坏值忽略（旧账本容忍），不抛错 */
function readPlan(e: any): Partial<Task> {
  const out: Partial<Task> = {};
  try { if (e.prio !== undefined && PRIO_RE.test(String(e.prio).toUpperCase())) out.prio = String(e.prio).toUpperCase(); } catch {}
  try { if (e.start !== undefined && DAY_RE.test(String(e.start))) out.start = String(e.start); } catch {}
  try { if (e.due !== undefined && DAY_RE.test(String(e.due))) out.due = String(e.due); } catch {}
  try { const n = Number(e.progress); if (e.progress !== undefined && Number.isInteger(n) && n >= 0 && n <= 100) out.progress = n; } catch {}
  return out;
}

export function plan(id: string, patch: PlanOptions): Task {
  const cur = get(id);
  const fields = planFields(patch);
  if (!Object.keys(fields).length) throw new Error("E_TASK: plan 至少需要一个字段（--prio/--start/--due/--progress）");
  const start = fields.start ?? cur.start, due = fields.due ?? cur.due;
  if (start && due && start > due) throw new Error("E_TASK: start 不能晚于 due");
  append({ event: "plan", id, ...fields });
  return get(id);
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
