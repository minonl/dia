// dia graph —— 任务/claim 依赖图（M1b，先 JSON 契约）
//
// 设计：docs/msg-collab-m1-design.md §3
// 只输出 declared 边；cycles 由任务 deps 计算；不做 inferred/UI。
import * as task from "./task.ts";
import * as claims from "./claims.ts";
import * as plan from "./plan.ts";

export interface GraphNode {
  id: string;
  kind: "task" | "session" | "path";
  label: string;
  status?: string;
  owner?: string;
  blocked_by?: string[];
  /** 计划优先级 P0–P99（M1.1，additive） */
  prio?: string;
  /** 计划开始日 YYYY-MM-DD */
  start?: string;
  /** 计划结束日 YYYY-MM-DD */
  due?: string;
  /** 进度 0–100；缺省时按 status 派生 */
  progress?: number;
  /** progress 是否来自派生（估算），而非人工录入 */
  progress_derived?: boolean;
  created_at?: string;
  updated_at?: string;
  /** 进入 done/accepted 的时间 */
  closed_at?: string;
  deps?: string[];
  touches?: string[];
  // ── M1.2 派生量（见 docs/design/graph-prio-dag.md）──
  eff_prio?: string;
  prio_inherited?: boolean;
  prio_source?: { id: string; declared: string; distance: number };
  critical?: boolean;
  ready?: boolean;
  startable?: boolean;
  released_by?: string[];
  dangling_deps?: string[];
  depth?: number;
  unblocks?: number;
  rank?: number | null;
  rank_key?: (string | number)[];
  rank_reason?: string;
  split_from?: string;
  split_children?: string[];
  slice?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "depends_on" | "touches" | "claims";
  source: "declared";
}

export interface Graph {
  schema: 1;
  /** 本版本可选的图能力；读者据此决定是否渲染优先级/时间线/进度 */
  capabilities?: string[];
  ranking?: { policy: "kahn-v1" };
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
}

const DERIVED_PROGRESS: Record<string, number> = { todo: 0, doing: 50, review: 80, done: 100, accepted: 100, blocked: 0, dropped: 0, rejected: 0, escalated: 50, awaiting_acceptance: 90 };

const taskNode = (id: string) => `task:${id}`;
const sessionNode = (id: string) => `session:${id}`;
const pathNode = (p: string) => `path:${p}`;

function findCycles(tasks: task.Task[]): string[][] {
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
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.deps || []) if (byId.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id);
  return cycles.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

export function build(opts: { task?: string } = {}): Graph {
  const tasks = task.list();
  const derived = plan.derive(tasks);
  const active = claims.list();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) {
    const blocked = t.deps.filter((d) => !task.isSatisfied(byId.get(d)));
    const d = derived.byId.get(t.id)!;
    nodes.set(taskNode(t.id), {
      id: taskNode(t.id), kind: "task", label: t.title, status: t.status, owner: t.owner,
      ...(blocked.length ? { blocked_by: blocked } : {}),
      ...(t.prio ? { prio: t.prio } : {}),
      ...(t.start ? { start: t.start } : {}),
      ...(t.due ? { due: t.due } : {}),
      progress: t.progress ?? (DERIVED_PROGRESS[t.status] ?? 0),
      progress_derived: t.progress === undefined,
      created_at: t.created_at,
      updated_at: t.updated_at,
      ...(t.closed_at ? { closed_at: t.closed_at } : {}),
      deps: t.deps,
      touches: t.touches,
      eff_prio: d.eff_prio,
      prio_inherited: d.prio_inherited,
      ...(d.prio_source ? { prio_source: d.prio_source } : {}),
      critical: d.critical,
      ready: d.ready,
      startable: d.startable,
      released_by: d.released_by,
      dangling_deps: d.dangling_deps,
      depth: d.depth,
      unblocks: d.unblocks,
      rank: d.rank,
      ...(d.rank_key ? { rank_key: d.rank_key } : {}),
      ...(d.rank_reason ? { rank_reason: d.rank_reason } : {}),
      ...(d.split_from ? { split_from: d.split_from } : {}),
      ...(d.split_children ? { split_children: d.split_children } : {}),
      ...(d.slice ? { slice: true } : {}),
    });
    if (t.owner) nodes.set(sessionNode(t.owner), { id: sessionNode(t.owner), kind: "session", label: t.owner });
    for (const d of t.deps) {
      if (byId.has(d)) edges.push({ from: taskNode(t.id), to: taskNode(d), kind: "depends_on", source: "declared" });
    }
    for (const p of t.touches) {
      nodes.set(pathNode(p), { id: pathNode(p), kind: "path", label: p });
      edges.push({ from: taskNode(t.id), to: pathNode(p), kind: "touches", source: "declared" });
    }
  }
  for (const c of active) {
    nodes.set(sessionNode(c.holder), { id: sessionNode(c.holder), kind: "session", label: c.holder });
    nodes.set(pathNode(c.path), { id: pathNode(c.path), kind: "path", label: c.path });
    edges.push({ from: sessionNode(c.holder), to: pathNode(c.path), kind: "claims", source: "declared" });
  }

  let filteredNodes = [...nodes.values()];
  let filteredEdges = edges;
  if (opts.task) {
    const root = taskNode(opts.task);
    if (!nodes.has(root)) throw new Error(`E_GRAPH: 任务不存在 ${opts.task}`);
    const keep = new Set<string>([root]);
    const t = byId.get(opts.task)!;
    for (const d of t.deps) if (byId.has(d)) keep.add(taskNode(d));
    for (const p of t.touches) {
      keep.add(pathNode(p));
      for (const c of active) if (c.path === p) { keep.add(pathNode(c.path)); keep.add(sessionNode(c.holder)); }
    }
    filteredNodes = filteredNodes.filter((n) => keep.has(n.id));
    filteredEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }

  filteredNodes.sort((a, b) => a.id.localeCompare(b.id));
  filteredEdges.sort((a, b) => (a.from + "\0" + a.to + "\0" + a.kind).localeCompare(b.from + "\0" + b.to + "\0" + b.kind));
  return { schema: 1, capabilities: ["prio", "timeline", "progress", "eff-prio", "ready", "rank", "split"], ranking: derived.ranking, nodes: filteredNodes, edges: filteredEdges, cycles: findCycles(tasks) };
}
