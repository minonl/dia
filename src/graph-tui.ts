// dia graph TUI —— 只读依赖图（终端，无网络）
//
// 设计：docs/msg-collab-m1-design.md §3；不使用 HTTP/daemon，保持框架“无网络模块”约束。
import type { Graph } from "./graph.ts";

const ORDER = ["doing", "blocked", "review", "todo", "awaiting_acceptance", "accepted", "done", "dropped", "rejected", "escalated"];
const color = (s: string, code: string, on: boolean) => on ? `\x1b[${code}m${s}\x1b[0m` : s;

export function render(g: Graph, opts: { color?: boolean } = {}): string {
  const on = opts.color ?? false;
  const tasks = g.nodes.filter((n) => n.kind === "task");
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const edgesFrom = (id: string, kind: string) => g.edges.filter((e) => e.from === id && e.kind === kind);
  const lines: string[] = [];

  const groups = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const st = t.status || "todo";
    groups.set(st, [...(groups.get(st) || []), t]);
  }
  for (const st of [...ORDER.filter((s) => groups.has(s)), ...[...groups.keys()].filter((s) => !ORDER.includes(s))]) {
    lines.push(color(`[${st}]`, "1;36", on));
    for (const t of groups.get(st)!.sort((a, b) => a.label.localeCompare(b.label))) {
      lines.push(`  ${color(t.label, "1", on)}  ${color(t.id.replace(/^task:/, ""), "2", on)}${t.owner ? `  owner=${t.owner}` : ""}`);
      for (const e of edgesFrom(t.id, "depends_on")) {
        const dep = taskById.get(e.to);
        lines.push(`    ${color("↳ depends", "34", on)} ${dep?.label || e.to}${dep ? ` [${dep.status}]` : ""}`);
      }
      for (const e of edgesFrom(t.id, "touches")) lines.push(`    ${color("↳ touches", "35", on)} ${e.to.replace(/^path:/, "")}`);
      if (t.blocked_by?.length) lines.push(`    ${color(`⚠ blocked_by ${t.blocked_by.join(", ")}`, "31", on)}`);
    }
    lines.push("");
  }
  if (!tasks.length) lines.push("(no tasks)");

  const claimEdges = g.edges.filter((e) => e.kind === "claims");
  if (claimEdges.length) {
    lines.push(color("claims", "1;36", on));
    for (const e of claimEdges) lines.push(`  ${e.from.replace(/^session:/, "")} → ${e.to.replace(/^path:/, "")}`);
    lines.push("");
  }
  for (const c of g.cycles) lines.push(color(`⚠ cycle: ${c.join(" -> ")}`, "31", on));
  return lines.join("\n");
}

/** 交互式刷新：仅终端 ANSI，不启服务；Ctrl-C 退出。 */
export function watch(build: () => Graph, opts: { intervalMs?: number; color?: boolean } = {}): Promise<never> {
  const paint = () => process.stdout.write("\x1b[2J\x1b[H" + render(build(), { color: opts.color ?? process.stdout.isTTY }) + "\n");
  paint();
  const timer = setInterval(() => { try { paint(); } catch { /* keep watching */ } }, opts.intervalMs ?? 2000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<never>(() => {});
}
