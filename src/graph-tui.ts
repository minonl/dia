// dia graph TUI —— 只读依赖图（终端，无网络）
//
// 设计：docs/msg-collab-m1-design.md §3；不使用 HTTP/daemon，保持框架“无网络模块”约束。
import type { Graph } from "./graph.ts";

const ORDER = ["doing", "blocked", "review", "todo", "awaiting_acceptance", "accepted", "done", "dropped", "rejected", "escalated"];
const color = (s: string, code: string, on: boolean) => on ? `\x1b[${code}m${s}\x1b[0m` : s;
const clip = (s: string, n: number) => {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const shortId = (id?: string) => id ? id.replace(/^ses_/, "").slice(-8) : "";

export interface RenderOptions {
  color?: boolean;
  status?: string;
  owner?: string;
  width?: number;
  now?: Date;
}

export function render(g: Graph, opts: RenderOptions = {}): string {
  const on = opts.color ?? false;
  const width = Math.max(32, opts.width ?? 96);
  const tasksAll = g.nodes.filter((n) => n.kind === "task");
  const tasks = tasksAll.filter((t) =>
    (!opts.status || t.status === opts.status) &&
    (!opts.owner || t.owner === opts.owner));
  const taskById = new Map(tasksAll.map((t) => [t.id, t]));
  const edgesFrom = (id: string, kind: string) => g.edges.filter((e) => e.from === id && e.kind === kind);
  const lines: string[] = [];

  const counts = new Map<string, number>();
  for (const t of tasksAll) counts.set(t.status || "todo", (counts.get(t.status || "todo") || 0) + 1);
  const countText = [...ORDER.filter((s) => counts.has(s)), ...[...counts.keys()].filter((s) => !ORDER.includes(s))]
    .map((s) => `${s}=${counts.get(s)}`).join(" ");
  const claims = g.edges.filter((e) => e.kind === "claims");
  const filter = [opts.status ? `status=${opts.status}` : "", opts.owner ? `owner=${opts.owner}` : ""].filter(Boolean).join(" ");
  lines.push(color(`dia graph  tasks=${tasksAll.length}  ${countText}  claims=${claims.length}${filter ? `  filter: ${filter}` : ""}`, "1", on));
  if (opts.now) lines.push(color(`updated ${opts.now.toLocaleTimeString()}`, "2", on));
  lines.push("");

  const groups = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const st = t.status || "todo";
    groups.set(st, [...(groups.get(st) || []), t]);
  }
  for (const st of [...ORDER.filter((s) => groups.has(s)), ...[...groups.keys()].filter((s) => !ORDER.includes(s))]) {
    lines.push(color(`[${st}]`, "1;36", on));
    for (const t of groups.get(st)!.sort((a, b) => a.label.localeCompare(b.label))) {
      const owner = t.owner ? `  @${shortId(t.owner)}` : "";
      const deps = edgesFrom(t.id, "depends_on").length;
      lines.push(`  ${color("●", "32", on)} ${color(clip(t.label, width - 24), "1", on)}  ${color(shortId(t.id.replace(/^task:/, "")), "2", on)}${owner}${deps ? `  deps=${deps}` : ""}`);
      for (const e of edgesFrom(t.id, "depends_on")) {
        const dep = taskById.get(e.to);
        lines.push(`    ${color("↳ depends", "34", on)} ${clip(dep?.label || e.to, width - 20)}${dep ? ` [${dep.status}]` : ""}`);
      }
      for (const e of edgesFrom(t.id, "touches")) lines.push(`    ${color("↳ touches", "35", on)} ${clip(e.to.replace(/^path:/, ""), width - 20)}`);
      if (t.blocked_by?.length) {
        const names = t.blocked_by.map((id) => taskById.get(`task:${id}`)?.label || id);
        lines.push(`    ${color(`⚠ blocked_by ${names.map((x) => clip(x, 40)).join(", ")}`, "31", on)}`);
      }
    }
    lines.push("");
  }
  if (!tasks.length) lines.push(opts.status || opts.owner ? "(no matching tasks)" : "(no tasks)");

  if (claims.length) {
    lines.push(color("claims", "1;36", on));
    for (const e of claims) {
      const holder = e.from.replace(/^session:/, "");
      if (opts.owner && holder !== opts.owner) continue;
      lines.push(`  ${shortId(holder)} → ${clip(e.to.replace(/^path:/, ""), width - 16)}`);
    }
    lines.push("");
  }
  for (const c of g.cycles) lines.push(color(`⚠ cycle: ${c.map((x) => x.replace(/^task:/, "")).join(" -> ")}`, "31", on));
  return lines.join("\n");
}

/** 交互式刷新：仅终端 ANSI，不启服务；Ctrl-C 退出。 */
export function watch(build: () => Graph, opts: RenderOptions & { intervalMs?: number } = {}): Promise<never> {
  const paint = () => process.stdout.write("\x1b[2J\x1b[H" + render(build(), { ...opts, now: new Date() }) + "\n");
  paint();
  const timer = setInterval(() => { try { paint(); } catch { /* keep watching */ } }, opts.intervalMs ?? 2000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<never>(() => {});
}
