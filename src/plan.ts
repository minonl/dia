// dia plan —— 依赖/优先级的派生量（M1：eff / ready / rank / lint）
// 设计：docs/design/graph-prio-dag.md
// 纯函数：零 IO、零时钟；rank 不含"今天"，保证 graph --json 两次运行字节相等。
import type { Task, Status } from "./task.ts";

export type Prio = string;
export const NO_PRIO = "P99";

const TERMINAL = new Set<Status>(["done", "accepted", "dropped", "rejected"]);
const SATISFIED = new Set<Status>(["done", "accepted", "dropped"]);
const PROPAGATE = new Set(["P0", "P1"]);

export const isTerminal = (t: Task) => TERMINAL.has(t.status);
export const isSatisfied = (t: Task | undefined) => !!t && SATISFIED.has(t.status);

/** P0→0 … P99→99；无/非法 prio 视为最后 */
export function prioIndex(p: string | undefined): number {
  const m = /^P(\d{1,2})$/.exec(String(p ?? "").toUpperCase());
  return m ? Number(m[1]) : 99;
}
export function prioName(idx: number): Prio {
  return idx >= 99 ? NO_PRIO : `P${idx}`;
}

export interface Derived {
  id: string;
  eff_prio: string;
  prio_inherited: boolean;
  prio_source?: { id: string; declared: string; distance: number };
  critical: boolean;
  ready: boolean;
  startable: boolean;
  blocked_by: string[];
  released_by: string[];
  dangling_deps: string[];
  depth: number;
  unblocks: number;
  rank: number | null;
  /** 排序键（eff,due,critical,slice,-unblocks,depth,created_at,id），供 UI 解释 */
  rank_key?: (string | number)[];
  /** 人话版排序依据 */
  rank_reason?: string;
  split_from?: string;
  split_children?: string[];
  slice?: boolean;
}

export interface LintFinding {
  kind: "cycle" | "dangling_dep" | "released_by_drop" | "long_chain";
  id: string;
  detail: string;
}

export interface DerivedResult {
  byId: Map<string, Derived>;
  cycles: string[][];
  lint: LintFinding[];
  ranking: { policy: "kahn-v1" };
}

/** 依赖图（只含已知任务） */
function graphOf(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dependents = new Map<string, string[]>(); // dep -> 依赖它的任务
  for (const t of tasks) for (const d of t.deps) if (byId.has(d)) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(t.id);
  return { byId, dependents };
}

/** 找环（与 graph.ts 的判定一致的稳定输出） */
export function findCycles(tasks: Task[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const st = state.get(id) || 0;
    if (st === 1) {
      const i = stack.indexOf(id);
      const cyc = i >= 0 ? stack.slice(i) : [id];
      const key = [...cyc].sort().join(",");
      if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
      return;
    }
    if (st === 2) return;
    state.set(id, 1); stack.push(id);
    for (const dep of byId.get(id)?.deps || []) if (byId.has(dep)) visit(dep);
    stack.pop(); state.set(id, 2);
  };
  for (const t of tasks) visit(t.id);
  return cycles.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

/** 有效优先级：从「声明 P0/P1 的非终态任务」向上游传播；不衰减、不累加 */
function computeEff(tasks: Task[], dependents: Map<string, string[]>) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const eff = new Map<string, { idx: number; src?: { id: string; declared: string; distance: number } }>();
  for (const t of tasks) eff.set(t.id, { idx: prioIndex(t.prio) });

  // 对每个 P0/P1 源做一次 BFS，记录最小距离；最终取「最小 idx → 最小距离 → 最小 id」
  for (const src of tasks) {
    const idx = prioIndex(src.prio);
    if (isTerminal(src) || !PROPAGATE.has(prioName(idx))) continue;
    const seen = new Map<string, number>([[src.id, 0]]);
    const queue: string[] = [src.id];
    while (queue.length) {
      const cur = queue.shift()!;
      const dist = seen.get(cur)!;
      for (const up of byId.get(cur)?.deps || []) {
        if (!byId.has(up) || seen.has(up)) continue;
        const upTask = byId.get(up)!;
        if (isTerminal(upTask)) continue; // 终态上游不再被"追认"
        seen.set(up, dist + 1); queue.push(up);
      }
    }
    for (const [id, distance] of seen) {
      if (id === src.id) continue;
      const cur = eff.get(id)!;
      const cand = { id: src.id, declared: prioName(idx), distance };
      if (idx < cur.idx) eff.set(id, { idx, src: cand });
      else if (idx === cur.idx && cur.src) {
        const better = cand.distance < cur.src.distance || (cand.distance === cur.src.distance && cand.id < cur.src.id);
        if (better) eff.set(id, { idx, src: cand });
      }
    }
  }
  return eff;
}

function longestDepth(tasks: Task[], byId: Map<string, Task>, cyclic: Set<string>) {
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0; // 环内截断
    const t = byId.get(id); if (!t) return 0;
    stack.add(id);
    let d = 0;
    for (const dep of t.deps) if (byId.has(dep) && !cyclic.has(dep)) d = Math.max(d, visit(dep, stack) + 1);
    stack.delete(id);
    memo.set(id, d); return d;
  };
  for (const t of tasks) visit(t.id, new Set());
  return memo;
}

function transitiveDependents(tasks: Task[], dependents: Map<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of tasks) {
    const seen = new Set<string>();
    const queue = [...(dependents.get(t.id) || [])];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      queue.push(...(dependents.get(cur) || []));
    }
    out.set(t.id, seen);
  }
  return out;
}

export function derive(tasks: Task[]): DerivedResult {
  const { byId, dependents } = graphOf(tasks);
  const cycles = findCycles(tasks);
  const cyclic = new Set(cycles.flat());
  const eff = computeEff(tasks, dependents);
  const depth = longestDepth(tasks, byId, cyclic);
  const down = transitiveDependents(tasks, dependents);

  // 关键路径候选：非终态 declared P0/P1 的所有祖先
  const critical = new Set<string>();
  for (const t of tasks) {
    const idx = prioIndex(t.prio);
    if (isTerminal(t) || !PROPAGATE.has(prioName(idx))) continue;
    const seen = new Set<string>();
    const queue = [t.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const dep of byId.get(cur)?.deps || []) {
        if (seen.has(dep) || !byId.has(dep)) continue;
        seen.add(dep); critical.add(dep); queue.push(dep);
      }
    }
  }

  const byIdOut = new Map<string, Derived>();
  for (const t of tasks) {
    const deps = t.deps;
    const dangling = deps.filter((d) => !byId.has(d));
    const unsatisfied = deps.filter((d) => (byId.has(d) ? !isSatisfied(byId.get(d)) : true));
    const released = deps.filter((d) => byId.get(d)?.status === "dropped");
    const hasCycle = cyclic.has(t.id);
    const ready = !isTerminal(t) && !hasCycle && unsatisfied.length === 0;
    const e = eff.get(t.id)!;
    byIdOut.set(t.id, {
      id: t.id,
      eff_prio: prioName(e.idx),
      prio_inherited: e.idx < prioIndex(t.prio),
      ...(e.src && e.idx < prioIndex(t.prio) ? { prio_source: e.src } : {}),
      critical: critical.has(t.id),
      ready,
      startable: ready && t.status === "todo",
      blocked_by: unsatisfied,
      released_by: released,
      dangling_deps: dangling,
      depth: depth.get(t.id) ?? 0,
      unblocks: down.get(t.id)?.size ?? 0,
      rank: null,
      ...(t.split_from ? { split_from: t.split_from } : {}),
      ...(t.split_children?.length ? { split_children: t.split_children } : {}),
      ...(t.slice ? { slice: true } : {}),
    });
  }

  // Kahn：非终态、非环内；key = eff → due → critical → -unblocks → depth → created_at → id
  const nodes = tasks.filter((t) => !isTerminal(t) && !cyclic.has(t.id));
  const indeg = new Map<string, number>();
  for (const t of nodes) indeg.set(t.id, t.deps.filter((d) => nodes.some((n) => n.id === d)).length);
  const readyQueue = nodes.filter((t) => (indeg.get(t.id) ?? 0) === 0);
  const key = (t: Task) => {
    const d = byIdOut.get(t.id)!;
    return [
      prioIndex(d.eff_prio),
      t.due ?? "9999-12-31",
      d.critical ? 0 : 1,
      d.slice ? 0 : 1,
      -d.unblocks,
      d.depth,
      t.created_at,
      t.id,
    ] as const;
  };
  const keyArray = (t: Task) => [...key(t)] as (string | number)[];
  const keyReason = (t: Task) => {
    const d = byIdOut.get(t.id)!;
    const bits = [`eff=${d.eff_prio}`];
    if (t.due) bits.push(`due=${t.due}`);
    if (d.critical) bits.push("关键闭包");
    if (d.slice) bits.push("最小切片");
    if (d.unblocks) bits.push(`解锁${d.unblocks}`);
    return bits.join(" · ");
  };
  const cmp = (a: Task, b: Task) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
  let rank = 0;
  const pending = [...readyQueue].sort(cmp);
  while (pending.length) {
    const t = pending.shift()!;
    const d = byIdOut.get(t.id)!;
    d.rank = ++rank;
    d.rank_key = keyArray(t);
    d.rank_reason = keyReason(t);
    for (const d of dependents.get(t.id) || []) {
      const n = indeg.get(d); if (n === undefined) continue;
      indeg.set(d, n - 1);
      if (n - 1 === 0) pending.push(byId.get(d)!);
    }
    pending.sort(cmp);
  }

  const lint: LintFinding[] = [];
  for (const t of tasks) {
    const d = byIdOut.get(t.id)!;
    for (const x of d.dangling_deps) lint.push({ kind: "dangling_dep", id: t.id, detail: `依赖不存在：${x}` });
    for (const x of d.released_by) lint.push({ kind: "released_by_drop", id: t.id, detail: `依赖已 dropped：${x}（前提失效，确认是否还需要做）` });
    if (PROPAGATE.has(t.prio ?? "") && !isTerminal(t) && d.depth >= 3) {
      lint.push({ kind: "long_chain", id: t.id, detail: `依赖链 ${d.depth} 跳，考虑拆分` });
    }
  }
  for (const c of cycles) lint.push({ kind: "cycle", id: c[0], detail: `环：${c.join(" → ")}` });

  return { byId: byIdOut, cycles, lint, ranking: { policy: "kahn-v1" } };
}
