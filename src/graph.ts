// dia graph —— 任务/claim 依赖图（M1b，先 JSON 契约）
//
// 设计：docs/msg-collab-m1-design.md §3
// 只输出 declared 边；cycles 由任务 deps 计算；不做 inferred/UI。
import * as task from "./task.ts";
import * as claims from "./claims.ts";

export interface GraphNode {
  id: string;
  kind: "task" | "session" | "path";
  label: string;
  status?: string;
  owner?: string;
  blocked_by?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "depends_on" | "touches" | "claims";
  source: "declared";
}

export interface Graph {
  schema: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
}

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
  const active = claims.list();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) {
    const blocked = t.deps.filter((d) => byId.get(d)?.status !== "done");
    nodes.set(taskNode(t.id), { id: taskNode(t.id), kind: "task", label: t.title, status: t.status, owner: t.owner, ...(blocked.length ? { blocked_by: blocked } : {}) });
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
  return { schema: 1, nodes: filteredNodes, edges: filteredEdges, cycles: findCycles(tasks) };
}
