// dia wb track —— 任务线 CLI（M2 接线）
//
// 设计：docs/design/workbench.md §6.1 / §9.1
// 约定：只做参数解析与错误码映射；业务写入一律走 src/workbench/track.ts。

import * as collab from "../../../src/collab.ts";
import * as track from "../../../src/workbench/track.ts";
import type { Track } from "../../../src/workbench/schema.ts";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

const VALUE_FLAGS = new Set([
  "--repo", "--goal", "--prio", "--owner", "--next", "--stage", "--remind-at",
  "--session", "--role", "--host", "--status", "--reason", "--set", "--waiting-on",
  "--from", "--to", "--task", "--id",
]);

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]);
  }
  return out;
}
function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (VALUE_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}
const has = (argv: string[], n: string) => argv.includes(n);
const json = (v: unknown) => out(JSON.stringify(v, null, 1));

function currentSession(): string | undefined {
  try { return collab.resolveSessionId(undefined); } catch { return undefined; }
}
function detectHost(): string {
  if (process.env.OPENCODE_SESSION_ID) return "opencode";
  return "cli";
}

function exitOf(e: any): number {
  const m = String(e?.message || e);
  if (m.startsWith("E_TRACK_AMBIGUOUS")) return 42;
  if (m.startsWith("E_TRACK_DUP")) return 43;
  if (m.startsWith("E_CLAIM_LEASE")) return 44;
  if (m.startsWith("E_USAGE")) return 2;
  if (m.startsWith("E_TRACK_NOT_FOUND")) return 2;
  return 1;
}

function renderTrack(t: Track): string {
  const lead = t.sessions.filter((s) => s.role === "lead" && !s.unbound_at).slice(-1)[0];
  return [
    `${t.id}  ${t.prio} ${t.status}  ${t.title}`,
    `  repo: ${t.repo.length ? t.repo.join(", ") : "-"}   owner: ${t.owner || "-"}   stage: ${t.stage || "-"}`,
    `  next: ${t.next || "-"}`,
    t.waiting_on ? `  waiting_on: ${t.waiting_on.kind}:${t.waiting_on.ref}${t.waiting_on.note ? `（${t.waiting_on.note}）` : ""}` : "",
    t.remind_at ? `  remind_at: ${t.remind_at}` : "",
    `  lead: ${lead ? `${lead.session_id}（${lead.host}）` : "-"}`,
    t.sessions.length ? `  sessions: ${t.sessions.map((s) => `${s.session_id}(${s.role}${s.unbound_at ? ",unbound" : ""})`).join(" ")}` : "",
    t.tasks.length ? `  tasks: ${t.tasks.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

export function wbTrackCli(argv: string[]): number {
  const sub = positional(argv)[0];
  const asJson = has(argv, "--json");
  try {
    switch (sub) {
      case "open": {
        const title = positional(argv)[1];
        if (!title) { err("usage: dia wb track open \"<title>\" --repo R [--repo R2] [--goal G] [--prio P1] [--next N]"); return 2; }
        const t = track.openTrack({
          title,
          goal: flag(argv, "--goal"),
          repo: flags(argv, "--repo"),
          prio: flag(argv, "--prio"),
          owner: flag(argv, "--owner"),
          next: flag(argv, "--next"),
          stage: flag(argv, "--stage"),
          remind_at: flag(argv, "--remind-at"),
        });
        const session = currentSession();
        const bound = session ? track.bindTrack(t.id, { session, role: "lead", host: detectHost() }) : t;
        if (asJson) json({ track: bound, bound_session: session || null });
        else {
          out(`opened ${bound.id}`);
          if (session) out(`  bound lead: ${session}`);
          else err("! warn: 没有会话标识（DIA_SESSION_ID / OPENCODE_SESSION_ID），未自动绑定 lead");
          out(renderTrack(bound));
        }
        return 0;
      }

      case "list": {
        const status = flag(argv, "--status") as any;
        const rows = track.listTracks(status ? { status } : {});
        if (asJson) json({ schema_v: 1, tracks: rows });
        else if (!rows.length) out("(none)");
        else for (const t of rows) out(renderTrack(t) + "\n");
        return 0;
      }

      case "show": {
        const id = positional(argv)[1] || flag(argv, "--id");
        if (!id) { err("usage: dia wb track show <tr-id>"); return 2; }
        const t = track.getTrack(id);
        if (!t) { err(`E_TRACK_NOT_FOUND: ${id}`); return 2; }
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "bind": {
        const id = positional(argv)[1];
        const session = flag(argv, "--session") || currentSession();
        if (!id) { err("usage: dia wb track bind <tr-id> [--session S] [--role lead|worker|reviewer]"); return 2; }
        if (!session) { err("E_NO_SESSION: 未找到会话标识（--session / DIA_SESSION_ID / OPENCODE_SESSION_ID）"); return 2; }
        const t = track.bindTrack(id, { session, role: (flag(argv, "--role") as any) || "lead", host: flag(argv, "--host") || detectHost() });
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "unbind": {
        const id = positional(argv)[1];
        const session = flag(argv, "--session") || currentSession();
        if (!id || !session) { err("usage: dia wb track unbind <tr-id> [--session S]"); return 2; }
        const t = track.unbind(id, { session });
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "stage": {
        const id = positional(argv)[1];
        if (!id) { err("usage: dia wb track stage <tr-id> [--status S] [--stage X] [--reason R] [--next N]"); return 2; }
        const t = track.stage(id, {
          status: flag(argv, "--status") as any,
          stage: flag(argv, "--stage"),
          reason: flag(argv, "--reason"),
          next: flag(argv, "--next"),
        });
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "next": {
        const id = positional(argv)[1];
        const next = flag(argv, "--set");
        if (!id || !next) { err("usage: dia wb track next <tr-id> --set \"一句话下一步\" [--waiting-on human:min] [--remind-at ISO]"); return 2; }
        const wo = flag(argv, "--waiting-on");
        const t = track.setNext(id, {
          next,
          waiting_on: wo ? track.parseWaitingOn(wo) : undefined,
          remind_at: flag(argv, "--remind-at"),
        });
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "handoff": {
        const id = positional(argv)[1];
        const from = flag(argv, "--from") || currentSession();
        const to = flag(argv, "--to");
        const reason = flag(argv, "--reason");
        if (!id || !from || !to || !reason) { err("usage: dia wb track handoff <tr-id> --from S --to S --reason R"); return 2; }
        const t = track.handoff(id, { from, to, reason });
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "attach": {
        const id = positional(argv)[1];
        const taskId = positional(argv)[2] || flag(argv, "--task");
        if (!id || !taskId) { err("usage: dia wb track attach <tr-id> <t-id>"); return 2; }
        const t = track.attachTask(id, taskId);
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      case "close": {
        const id = positional(argv)[1];
        const reason = flag(argv, "--reason");
        const evidence = flag(argv, "--evidence");
        if (!id || !reason) { err("usage: dia wb track close <tr-id> --reason accepted|abandoned [--evidence E]"); return 2; }
        const t = track.close(id, { reason, evidence });
        if (asJson) json(t); else out(renderTrack(t));
        return 0;
      }

      default:
        err("usage: dia wb track open|list|show|bind|unbind|stage|next|handoff|attach|close");
        return 2;
    }
  } catch (e: any) {
    err(e?.message || String(e));
    return exitOf(e);
  }
}
