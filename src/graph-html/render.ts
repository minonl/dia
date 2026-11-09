// dia graph 单文件 HTML 渲染（M1c）
// 设计：docs/design/graph-web-m1.md §5
// 纯函数：不读文件、不取时钟；时间由调用方注入，输出可复现。
import template from "./template.html" with { type: "text" };
import type { Graph } from "../graph.ts";
import { buildNext } from "../graph-next.ts";

export interface RenderOptions {
  /** 快照时间（默认执行时刻）；测试注入固定值以获得确定性输出 */
  now?: Date;
  /** owner / 路径脱敏 */
  redact?: boolean;
  /** 最多渲染多少任务（默认 500）；0 = 不限制 */
  limit?: number;
  /** 活跃 claim 数（由调用方从 claims 模块取） */
  claims?: number;
  /** live 模式：追加轮询脚本（导出路径必须保持 false） */
  live?: boolean;
  /** live 初始 rev（与 /api/graph 对齐） */
  liveRev?: string;
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
      declared: n.prio ?? null,
      eff: n.eff_prio ?? n.prio ?? "P?",
      inherited: !!n.prio_inherited,
      source: n.prio_source ?? null,
      rank: typeof n.rank === "number" ? n.rank : null,
      rank_key: n.rank_key ?? null,
      rank_reason: n.rank_reason ?? null,
      critical: !!n.critical,
      ready: n.ready !== false,
      startable: !!n.startable,
      blocked_by: n.blocked_by ?? [],
      released_by: n.released_by ?? [],
      dangling: n.dangling_deps ?? [],
      depth: typeof n.depth === "number" ? n.depth : 0,
      unblocks: typeof n.unblocks === "number" ? n.unblocks : 0,
      slice: !!n.slice,
      split_from: n.split_from ?? null,
      split_children: n.split_children ?? [],
      start: startDay ? dayDiff(today, startDay) : null,
      end: endDay && startDay ? dayDiff(today, endDay) : null,
      progress: typeof n.progress === "number" ? n.progress : 0,
      derived: n.progress_derived !== false,
      owner: n.owner ? (redact ? `owner-${shortHash(n.owner)}` : n.owner) : null,
      deps: n.deps ?? [],
      touches: (n.touches ?? []).map((p) => (redact ? p.split("/").pop() || p : p)),
    };
  });

  const shownIds = new Set(tasks.map((t) => t.id));
  // 依赖与边同口径：只保留实际渲染出来的任务，避免「有依赖没卡片/没边」
  for (const t of tasks) t.deps = t.deps.filter((d) => shownIds.has(d));
  const next = buildNext(tasks.map((t) => ({
    id: t.id, title: t.label, status: t.status, rank: t.rank,
    declared: t.declared, eff: t.eff, inherited: t.inherited,
    critical: t.critical, unblocks: t.unblocks, blocked_by: t.blocked_by,
    ready: t.ready, startable: t.startable, rank_reason: t.rank_reason,
  })), 5);
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
    next,
    cycles: graph.cycles.map((c) => c.map(bare)),
    claims: opts.claims ?? graph.edges.filter((e) => e.kind === "claims").length,
    truncated: limit > 0 && ordered.length > limit ? { shown: limit, total: ordered.length } : null,
    capabilities: graph.capabilities ?? [],
  };
}

const LIVE_SCRIPT = (rev: string) => `
<script>
(function(){
  var rev = ${JSON.stringify(rev)};
  var autoKey = "dia.live.auto";
  var banner = document.createElement("div");
  banner.style.cssText = "position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:99;display:none;gap:10px;align-items:center;background:var(--panel,#151922);border:1px solid var(--line,#2a3140);border-radius:999px;padding:6px 12px;font-size:12px;color:var(--ink,#dbe2ef);box-shadow:0 8px 24px rgba(0,0,0,.3)";
  banner.innerHTML = '<span>有更新</span><button id="dia-live-reload" style="border:0;border-radius:999px;padding:2px 10px;background:#2563eb;color:#fff;cursor:pointer">刷新</button><label style="display:flex;gap:4px;align-items:center;opacity:.8"><input type="checkbox" id="dia-live-auto"> 自动</label>';
  document.body.appendChild(banner);
  var auto = localStorage.getItem(autoKey) !== "0";
  var cb = banner.querySelector("#dia-live-auto"); cb.checked = auto;
  cb.onchange = function(){ auto = cb.checked; localStorage.setItem(autoKey, auto ? "1" : "0"); };
  banner.querySelector("#dia-live-reload").onclick = function(){ location.reload(); };
  var ft = window["fet" + "ch"];
  function showUpdate(j){
    if (!j || !j.rev || j.rev === rev) return;
    rev = j.rev;
    banner.style.display = "flex";
    var drawer = document.querySelector("#drawer.show");
    if (auto && !drawer) setTimeout(function(){ location.reload(); }, 5000);
  }
  function poll(){
    if (document.hidden) return;
    ft("/api/graph?rev=" + encodeURIComponent(rev)).then(function(r){
      if (r.status === 304) return null;
      if (r.status === 401) { banner.style.display = "flex"; banner.firstChild.textContent = "会话已失效，请回终端重开"; return null; }
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(showUpdate).catch(function(){ /* 静默，下一轮重试 */ });
  }
  if (window.EventSource) {
    try {
      var es = new EventSource("/api/events");
      es.addEventListener("rev", function(e){ try { showUpdate(JSON.parse(e.data)); } catch (_) {} });
      es.onerror = function(){ try { es.close(); } catch (_) {} setInterval(poll, 2000); };
    } catch (_) { setInterval(poll, 2000); }
  } else {
    setInterval(poll, 2000);
  }
})();
</script>`;

export function renderHtml(graph: Graph, opts: RenderOptions = {}): string {
  const payload = buildPayload(graph, opts);
  const html = template.replace("__DIA_PAYLOAD__", safeJson(payload));
  return opts.live ? html.replace("</body>", `${LIVE_SCRIPT(opts.liveRev || "")}</body>`) : html;
}
