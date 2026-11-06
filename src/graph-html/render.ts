// dia graph 单文件 HTML 渲染（M1c）
// 设计：docs/design/graph-web-m1.md §5
// 纯函数：不读文件、不取时钟；时间由调用方注入，输出可复现。
import template from "./template.html" with { type: "text" };
import type { Graph } from "../graph.ts";

export interface RenderOptions {
  /** 快照时间（默认执行时刻）；测试注入固定值以获得确定性输出 */
  now?: Date;
  /** owner / 路径脱敏 */
  redact?: boolean;
  /** 最多渲染多少任务（默认 500）；0 = 不限制 */
  limit?: number;
  /** 活跃 claim 数（由调用方从 claims 模块取） */
  claims?: number;
}

export interface WebTask {
  id: string;
  label: string;
  status: string;
  prio: string | null;
  start: number | null;
  end: number | null;
  progress: number;
  derived: boolean;
  owner: string | null;
  deps: string[];
  touches: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日 YYYY-MM-DD（禁止 toISOString：东八区午夜会被折回前一天） */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 两个 YYYY-MM-DD 的天数差（UTC 计算，避开夏令时） */
export function dayDiff(from: string, to: string): number {
  const a = from.split("-").map(Number), b = to.split("-").map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function safeJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const bare = (id: string) => id.replace(/^task:/, "");

export function buildPayload(graph: Graph, opts: RenderOptions = {}) {
  const now = opts.now ?? new Date();
  const today = localDay(now);
  const limit = opts.limit === undefined ? 500 : opts.limit;
  const redact = !!opts.redact;

  const taskNodes = graph.nodes.filter((n) => n.kind === "task");
  const known = new Set(taskNodes.map((n) => n.id));
  // 稳定排序：优先级 → 开始 → id，截断时不随账本顺序抖动
  const ordered = [...taskNodes].sort((a, b) =>
    String(a.prio ?? "P9").localeCompare(String(b.prio ?? "P9")) ||
    String(a.start ?? a.created_at ?? "").localeCompare(String(b.start ?? b.created_at ?? "")) ||
    a.id.localeCompare(b.id));
  const shown = limit > 0 ? ordered.slice(0, limit) : ordered;

  const tasks: WebTask[] = shown.map((n) => {
    const startDay = n.start ?? (n.created_at ? localDay(new Date(n.created_at)) : null);
    const endDay = n.due ?? (n.closed_at ? localDay(new Date(n.closed_at)) : null);
    return {
      id: bare(n.id),
      label: n.label,
      status: n.status ?? "todo",
      prio: n.prio ?? null,
      start: startDay ? dayDiff(today, startDay) : null,
      end: endDay && startDay ? dayDiff(today, endDay) : null,
      progress: typeof n.progress === "number" ? n.progress : 0,
      derived: n.progress_derived !== false,
      owner: n.owner ? (redact ? `owner-${shortHash(n.owner)}` : n.owner) : null,
      deps: (n.deps ?? []).filter((d) => known.has(`task:${d}`)),
      touches: (n.touches ?? []).map((p) => (redact ? p.split("/").pop() || p : p)),
    };
  });

  const shownIds = new Set(tasks.map((t) => t.id));
  const edges = graph.edges
    .filter((e) => e.kind === "depends_on")
    .map((e) => ({ from: bare(e.from), to: bare(e.to), kind: "depends_on" as const }))
    .filter((e) => shownIds.has(e.from) && shownIds.has(e.to));

  return {
    schema: 1 as const,
    today,
    generated_at: `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    tasks,
    edges,
    cycles: graph.cycles.map((c) => c.map(bare)),
    claims: opts.claims ?? graph.edges.filter((e) => e.kind === "claims").length,
    truncated: limit > 0 && ordered.length > limit ? { shown: limit, total: ordered.length } : null,
    capabilities: graph.capabilities ?? [],
  };
}

export function renderHtml(graph: Graph, opts: RenderOptions = {}): string {
  const payload = buildPayload(graph, opts);
  return template.replace("__DIA_PAYLOAD__", safeJson(payload));
}
