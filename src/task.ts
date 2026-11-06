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
  /** 由 split 产生：父任务 id（元数据，不是图边） */
  split_from?: string;
  /** 由 split 产生：子任务 id 列表（元数据，不是图边） */
  split_children?: string[];
  /** 最小可用切片标记（排序 tiebreak + 展示） */
  slice?: boolean;
  /** judge 继承自父任务 */
  judge_inherited?: boolean;
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
    if (e.event === "split" && e.parent && Array.isArray(e.children)) {
      const parent = map.get(e.parent);
      if (parent) {
        for (const c of e.children) {
          if (!c || !c.id || map.has(c.id)) continue;
          map.set(c.id, {
            id: c.id, title: c.title || c.id, role: c.role || "builder",
            judge: c.judge || "", status: "todo", evidence: "",
            deps: [], touches: uniq(c.touches || []),
            created_at: e.ts, updated_at: e.ts,
            split_from: e.parent,
            ...(c.judge ? { judge_inherited: true } : {}),
            ...(e.slice && e.slice === c.id ? { slice: true } : {}),
          });
        }
        const ids = e.children.map((c: any) => c.id).filter((id: string) => map.has(id));
        parent.deps = uniq([...parent.deps, ...ids]);
        parent.split_children = uniq([...(parent.split_children || []), ...ids]);
      }
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

const SATISFIED: Status[] = ["done", "accepted", "dropped"];
/** 依赖是否已满足（done / accepted / dropped）；dangling 由调用方单独判断 */
export function isSatisfied(t: Task | undefined): boolean {
  return !!t && SATISFIED.includes(t.status);
}
/** 终态：不再参与排序/传播 */
export function isTerminal(t: Task | undefined): boolean {
  return !!t && ["done", "accepted", "dropped", "rejected"].includes(t.status);
}

export interface SplitOptions {
  slice?: string;
  role?: string;
  judge?: string;
  touches?: string[];
  force?: boolean;
}

/** 拆分：父 depends on 子（父 = 集成收口）；单条原子 split 事件落账 */
export function split(parentId: string, titles: string[], opts: SplitOptions = {}): Task {
  const parent = get(parentId);
  if (isTerminal(parent)) throw new Error("E_TASK: 终态任务不能拆分");
  if (parent.status === "doing" && !opts.force) throw new Error("E_TASK: 进行中的任务拆分需 --force（拆分后会先等子任务）");
  const names = titles.map((x) => x.trim()).filter(Boolean);
  if (names.length < 2) throw new Error("E_TASK: 至少拆成 2 个切片");
  if (new Set(names).size !== names.length) throw new Error("E_TASK: 切片标题重复");
  if (opts.slice && !names.includes(opts.slice)) throw new Error("E_TASK: --slice 必须是某个切片标题");

  const judge = opts.judge ?? parent.judge;
  const children = names.map((title) => ({
    id: "t-" + createHash("sha1").update(title + Date.now() + Math.random()).digest("hex").slice(0, 8),
    title,
    role: opts.role || parent.role,
    judge,
    touches: uniq(opts.touches ?? parent.touches),
  }));
  const sliceId = opts.slice ? children[names.indexOf(opts.slice)].id : undefined;
  append({ event: "split", parent: parentId, children, ...(sliceId ? { slice: sliceId } : {}) });
  return get(parentId);
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
