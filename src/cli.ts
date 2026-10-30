import { buildIndex, search, lint, getDoc } from "./kb.ts";
import { ingest, readGitUpdates } from "./ingest.ts";
import * as audit from "./audit.ts";
import * as freeze from "./freeze.ts";
import { runWrapped } from "./run.ts";
import { countCalls } from "./runtime.ts";
import { resumeCard } from "./resume.ts";
import * as persona from "./persona.ts";
import * as task from "./task.ts";
import * as team from "./team.ts";
import { loadPrices } from "./pricing.ts";
import { propose } from "./proposal.ts";
import { runJob } from "./job.ts";

function out(s: string) { process.stdout.write(s + "\n"); }
function err(s: string) { process.stderr.write(s + "\n"); }

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(name); }
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { if (!args[i].includes("=")) i++; continue; }
    out.push(args[i]);
  }
  return out;
}
function rootOf(args: string[]): string {
  return flag(args, "--root") || process.env.DIA_KB_ROOT || process.cwd();
}

function help() {
  out(`dia (嗲) — agent framework

usage:
  dia kb index [--root DIR] [--db PATH] [--json]
  dia kb search <query> [--root DIR] [--db PATH] [--limit N] [--json]
  dia kb query <query> [--root DIR] [--db PATH] [--limit N] [--json] [--full] [--bytes]
  dia kb review [--root DIR] [--db PATH] [--json]
  dia kb lint [--root DIR] [--db PATH] [--stale-days N] [--json] [--strict]
  dia kb get <path> [--root DIR] [--section HEADING]
  dia ingest sessions [--source dsh|opencode|all] [--domain dabo|yan] [--since ISO]
                      [--full] [--limit N] [--dry-run] [--out DIR] [--project ID] [--json]
  dia ingest git --repo DIR [--since DATE] [--limit N] [--json]
  dia audit append --session S --tool T [--decision allow|deny|waive] [--params JSON]
                    [--risk N] [--redline] [--note ...] [--json]
  dia audit verify --session S --calls N [--json]
  dia audit score --session S [--json]
  dia audit tail [--n 20] [--json]
  dia freeze --reason R [--auto] [--last-episode ID] [--json]
  dia freeze status
  dia freeze thaw --reason R --i-am-human
  dia guard [--once] [--json]
  dia run --session S [--tool T] [--agent A] [--waive --risk N] [--redline] -- <cmd> [args...]
  dia resume --session S [--json]
  dia persona add <id|--from SRC> [--ref REF] [--host opencode] [--dry-run] [--json]
  dia persona list|verify|remove
  dia task add|list|status|done
  dia team run <id> --mock | --acp|--dsh --workspace DIR
  dia team gate|accept|reject|next
  dia job <list|status|install|...>   # 调度适配器
  dia price list|--json
  dia version`);
}

async function kb(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const root = rootOf(args);
  const db = flag(args, "--db");
  if (sub === "index") {
    const res = await buildIndex(root, db);
    out(has(args, "--json") ? JSON.stringify(res) : `indexed ${res.docs} docs -> ${res.db} (${res.tokenizer})`);
    return 0;
  }
  if (sub === "search" || sub === "query") {
    const q = positional(args)[0];
    if (!q) return err("missing query") as any ?? 2;
    const limit = Number(flag(args, "--limit") || 10);
    const rows = await search(root, q, db, limit);
    const full = sub === "query" && has(args, "--full");
    const bytes = sub === "query" && has(args, "--bytes");
    const enrich = rows.map((r) => {
      const item: any = { ...r };
      if (bytes) item.bytes = Buffer.byteLength(getDoc(root, r.path), "utf8");
      if (full) item.text = getDoc(root, r.path);
      return item;
    });
    if (has(args, "--json")) out(JSON.stringify(enrich));
    else for (const r of enrich) {
      out(`${r.path}\t${r.title}\n  ${r.snippet}`);
      if (r.bytes !== undefined) out(`  bytes ${r.bytes}`);
      if (r.text !== undefined) out(r.text);
    }
    return rows.length ? 0 : 1;
  }
  if (sub === "review") {
    const res = await lint(root, db, Number(flag(args, "--stale-days") || 180));
    const data = {
      missing: res.review_missing_paths,
      overdue: res.review_overdue,
      stale: res.stale,
    };
    if (has(args, "--json")) out(JSON.stringify(data, null, 1));
    else {
      out(`review missing: ${data.missing.length}`);
      for (const p of data.missing) out(`  missing  ${p}`);
      out(`review overdue: ${data.overdue.length}`);
      for (const r of data.overdue) out(`  overdue  ${r.path} (review_by ${r.review_by})`);
      out(`stale: ${data.stale.length}`);
      for (const r of data.stale) out(`  stale    ${r.path} (${r.age_days}d)`);
    }
    return data.missing.length || data.overdue.length ? 1 : 0;
  }
  if (sub === "lint") {
    const res = await lint(root, db, Number(flag(args, "--stale-days") || 180));
    if (has(args, "--json")) out(JSON.stringify(res, null, 1));
    else {
      out(`docs ${res.docs} | bytes ${res.bytes} | tokens≈${res.tokens_est}`);
      out(`index covered: ${res.index_covered} | missing: ${res.index_missing.length}`);
      out(`review missing: ${res.review_missing} | overdue: ${res.review_overdue.length} | stale: ${res.stale.length}`);
      out(`broken links: ${res.broken_links.length}`);
      for (const b of res.broken_links.slice(0, 10)) out(`  broken  ${b.path} -> ${b.link}`);
      for (const m of res.index_missing.slice(0, 10)) out(`  missing  ${m}`);
      for (const b of res.biggest) out(`  big      ${b.path} (~${b.tokens} tokens)`);
    }
    if (has(args, "--strict")) return res.index_missing.length || res.broken_links.length || res.review_overdue.length ? 1 : 0;
    return 0;
  }
  if (sub === "get") {
    const rel = positional(args)[0];
    if (!rel) { err("missing path"); return 2; }
    try { out(getDoc(root, rel, flag(args, "--section"))); return 0; }
    catch (e: any) { err(e?.message || String(e)); return 2; }
  }
  help();
  return 0;
}

async function ingestCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const domain = flag(args, "--domain") || "local";
  if (domain === "yan" && !has(args, "--i-own-this")) {
    err("refusing: --domain yan requires --i-own-this (work data stays in the work domain)");
    return 3;
  }
  if (sub === "sessions") {
    if (domain === "yan") err("warning: ingesting work-domain sessions; output stays on this machine");
    const sources = (flag(args, "--source") || "all");
    const res = await ingest({
      sources: sources === "all" ? undefined : [sources as "dsh" | "opencode"],
      domain,
      since: flag(args, "--since"),
      full: has(args, "--full"),
      limit: flag(args, "--limit") ? Number(flag(args, "--limit")) : undefined,
      dryRun: has(args, "--dry-run"),
      sessionsRoot: flag(args, "--sessions-root"),
      opencodeDb: flag(args, "--opencode-db"),
      outDir: flag(args, "--out"),
      cacheDir: flag(args, "--cache-dir"),
      project: flag(args, "--project"),
    });
    if (has(args, "--json")) {
      out(JSON.stringify({ scanned: res.scanned, skipped: res.skipped, written: res.written, candidates: res.candidates, redactions: res.redactions }));
    } else {
      out(`scanned ${res.scanned} | skipped ${res.skipped} | written ${res.written} | candidates ${res.candidates}`);
      out(`redactions: ${JSON.stringify(res.redactions)}`);
      for (const e of res.episodes.slice(0, 5)) out(`  ${e.ts_start}  ${e.source}  turns=${e.turns} tools=${e.tools.reduce((a, t) => a + t.count, 0)}  ${e.summary.slice(0, 60)}`);
    }
    return 0;
  }
  if (sub === "git") {
    const repo = flag(args, "--repo");
    if (!repo) { err("missing --repo"); return 2; }
    const since = flag(args, "--since") || "30 days ago";
    const rows = readGitUpdates(repo, since, flag(args, "--limit") ? Number(flag(args, "--limit")) : 200);
    if (has(args, "--json")) out(JSON.stringify(rows, null, 1));
    else for (const r of rows) out(`${r.time}  ${r.hash.slice(0, 8)}  ${r.subject}  (${r.files.length} files)`);
    return 0;
  }
  err("usage: dia ingest sessions|git ...");
  return 2;
}

async function auditCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  if (sub === "append") {
    const session = flag(args, "--session");
    const tool = flag(args, "--tool");
    if (!session || !tool) { err("missing --session/--tool"); return 2; }
    let params: unknown = null;
    if (flag(args, "--params")) {
      try { params = JSON.parse(flag(args, "--params")!); } catch { err("bad --params json"); return 2; }
    }
    const ev = audit.append({
      session, tool, params,
      agent: flag(args, "--agent") || null,
      decision: (flag(args, "--decision") || "allow") as any,
      waiver_id: flag(args, "--waiver"),
      risk: flag(args, "--risk") ? Number(flag(args, "--risk")) : undefined,
      exit: flag(args, "--exit-code") ? Number(flag(args, "--exit-code")) : undefined,
      redline: has(args, "--redline"),
      note: flag(args, "--note"),
    });
    out(asJson ? JSON.stringify(ev) : "audit appended: " + ev.tool + " " + ev.decision);
    return 0;
  }
  if (sub === "verify") {
    const session = flag(args, "--session");
    if (!session) { err("missing --session"); return 2; }
    const auto = !flag(args, "--calls");
    const calls = auto ? countCalls(session) : Number(flag(args, "--calls"));
    if (Number.isNaN(calls)) { err("bad --calls"); return 2; }
    const r = audit.verify(session, calls);
    out(asJson ? JSON.stringify({ ...r, expected_source: auto ? "runtime" : "manual" })
      : `audit_rows=${r.audit_rows} expected=${r.expected_calls} (${auto ? "runtime" : "manual"}) ok=${r.ok} gap=${r.gap}`);
    return r.ok ? 0 : 1;
  }
  if (sub === "score") {
    const session = flag(args, "--session");
    if (!session) { err("missing --session"); return 2; }
    const r = audit.score(session);
    out(asJson ? JSON.stringify(r) : `score=${r.score} level=${r.level} (${r.reasons.join(", ")})`);
    return 0;
  }
  if (sub === "tail") {
    const n = Number(flag(args, "--n") || 20);
    const rows = audit.tail(n);
    if (asJson) out(JSON.stringify(rows, null, 1));
    else for (const r of rows) out(`${r.ts} ${r.session} ${r.tool} ${r.decision}${r.redline ? " REDLINE" : ""}`);
    return 0;
  }
  err("usage: dia audit append|verify|score|tail");
  return 2;
}

async function freezeCli(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  const bare = !first || first.startsWith("-");
  const sub = bare ? "freeze" : first;
  const args = bare ? argv : rest;
  const asJson = has(args, "--json");
  if (sub === "status") {
    const st = freeze.status();
    if (asJson) out(JSON.stringify(st, null, 1));
    else out(st.frozen ? `FROZEN since ${st.since} by ${st.by}: ${st.reason}` : "normal");
    return st.frozen ? 1 : 0;
  }
  if (sub === "thaw") {
    try {
      const r = freeze.thaw({ reason: flag(args, "--reason") || "", human: has(args, "--i-am-human") });
      out(asJson ? JSON.stringify(r) : (r.thawed ? "thawed" : "not frozen"));
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return 3;
    }
  }
  if (sub === "--help" || sub === "-h") { out("dia freeze [--reason R] [--session S] [--auto] [--last-episode ID] | dia freeze status | dia freeze thaw --reason R --i-am-human"); return 0; }
  const reason = flag(args, "--reason");
  if (!reason) { err("missing --reason"); return 2; }
  const st = freeze.freeze({ reason, by: has(args, "--auto") ? "auto" : "human", lastEpisode: flag(args, "--last-episode"), session: flag(args, "--session") });
  out(asJson ? JSON.stringify(st) : `frozen: ${st.reason}`);
  return 0;
}

async function guardCli(argv: string[]): Promise<number> {
  const st = freeze.status();
  const asJson = has(argv, "--json");
  if (asJson) out(JSON.stringify({ ...st, action: st.frozen ? "block" : "allow" }));
  else out(st.frozen ? `blocked: ${st.reason}` : "allow");
  return st.frozen ? 42 : 0;
}

async function taskCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  try {
    if (sub === "add") {
      const title = positional(args).filter((x) => x !== "add").join(" ") || flag(args, "--title");
      if (!title) { err("missing title"); return 2; }
      const t = task.add(title, { role: flag(args, "--role"), judge: flag(args, "--judge") });
      out(asJson ? JSON.stringify(t) : `${t.id} ${t.title}`);
      return 0;
    }
    if (sub === "list") {
      const rows = task.list();
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((t) => `${t.id}\t${t.status}\t${t.title}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "status") {
      const id = positional(args)[0];
      const st = positional(args)[1] as task.Status;
      if (!id || !st) { err("usage: dia task status <id> <status> [--evidence ...]"); return 2; }
      const t = task.status(id, st, flag(args, "--evidence"));
      out(asJson ? JSON.stringify(t) : `${t.id} -> ${t.status}`);
      return 0;
    }
    if (sub === "done") {
      const id = positional(args)[0];
      if (!id) { err("missing id"); return 2; }
      const t = task.status(id, "done", flag(args, "--evidence"));
      out(asJson ? JSON.stringify(t) : `${t.id} -> done`);
      return 0;
    }
  } catch (e: any) { err(e?.message || String(e)); return 30; }
  err("usage: dia task add|list|status|done");
  return 2;
}

async function teamCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  const id = positional(args)[0];
  try {
    if (sub === "run") {
      if (!id) { err("missing task id"); return 2; }
      if (has(args, "--mock")) {
        const dir = team.runMock(id);
        out(asJson ? JSON.stringify({ task: id, dir }) : `awaiting_acceptance: ${dir}`);
        return 0;
      }
      if (has(args, "--acp") || has(args, "--dsh")) {
        const ws = flag(args, "--workspace");
        if (!ws) { err("--workspace required with --acp/--dsh"); return 2; }
        const r = has(args, "--dsh") ? await team.runDsh(id, ws) : await team.runAcp(id, ws);
        out(asJson ? JSON.stringify({ task: id, dir: r.dir, verify: r.verify, escalated: !!r.escalated })
          : (r.escalated ? `escalated: ${r.dir}` : `awaiting_acceptance: ${r.dir}`));
        return r.escalated ? 30 : 0;
      }
      err("use --mock or --acp|--dsh --workspace <dir>");
      return 33;
    }
    if (sub === "gate") {
      const g = team.gate(id);
      out(asJson ? JSON.stringify(g) : (g.ok ? "gate ok" : "gate fail: " + g.reason));
      return g.ok ? 0 : 30;
    }
    if (sub === "accept") {
      const t = team.accept(id, flag(args, "--note"));
      out(asJson ? JSON.stringify(t) : `${t.id} -> accepted`);
      return 0;
    }
    if (sub === "next") {
      const rows = propose({
        depsPath: flag(args, "--deps"),
        hypothesesPath: flag(args, "--hypotheses"),
        limit: flag(args, "--limit") ? Number(flag(args, "--limit")) : 3,
      });
      if (asJson) out(JSON.stringify(rows, null, 1));
      else for (const p of rows) {
        out(`- [${p.severity}] ${p.title}  (score ${p.score}, cost ${p.cost})`);
        out(`  why: ${p.why}`);
        for (const e of p.evidence) out(`  · ${e}`);
      }
      return 0;
    }
    if (sub === "reject") {
      const t = team.reject(id, flag(args, "--reason") || "");
      out(asJson ? JSON.stringify(t) : `${t.id} -> rejected`);
      return 0;
    }
  } catch (e: any) { err(e?.message || String(e)); return 30; }
  err("usage: dia team run|gate|accept|reject");
  return 2;
}

async function personaCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  if (sub === "add") {
    const id = positional(args)[0];
    const from = flag(args, "--from") || id;
    if (!from) { err("missing --from"); return 2; }
    try {
      const r = persona.install(from, { ref: flag(args, "--ref"), host: flag(args, "--host"), dryRun: has(args, "--dry-run") });
      out(asJson ? JSON.stringify(r) : `installed ${r.id}@${r.version} -> ${r.rendered.join(", ") || "(dry-run)"}`);
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      const msg = e?.message || "";
      if (msg.startsWith("E_CONFLICT") || msg.startsWith("E_MANIFEST")) return 32;
      if (msg.startsWith("E_HOST")) return 33;
      return 31;
    }
  }
  if (sub === "list") {
    const rows = persona.list();
    out(asJson ? JSON.stringify(rows, null, 1) : rows.map((r) => `${r.id}: ${r.versions.join(", ")}`).join("\n") || "(none)");
    return 0;
  }
  if (sub === "verify") {
    const id = positional(args)[0];
    if (!id) { err("missing id"); return 2; }
    try {
      const r = persona.verify(id, flag(args, "--version"));
      out(asJson ? JSON.stringify(r) : `${r.ok ? "ok" : "MISMATCH"} ${r.dir}`);
      return r.ok ? 0 : 1;
    } catch (e: any) { err(e?.message || String(e)); return 31; }
  }
  if (sub === "remove") {
    const id = positional(args)[0];
    if (!id) { err("missing id"); return 2; }
    try {
      const r = persona.remove(id);
      out(asJson ? JSON.stringify(r) : `removed ${id}${r.removed.length ? " (" + r.removed.join(", ") + ")" : ""}` +
        (r.skipped?.length ? `\nskipped (hash/allowlist mismatch): ${r.skipped.join(", ")}` : ""));
      return r.skipped?.length ? 30 : 0;
    } catch (e: any) { err(e?.message || String(e)); return 31; }
  }
  err("usage: dia persona add|list|verify|remove");
  return 2;
}

async function resumeCli(argv: string[]): Promise<number> {
  const session = flag(argv, "--session");
  if (!session) { err("missing --session"); return 2; }
  try {
    const card = resumeCard(session);
    if (has(argv, "--json")) out(JSON.stringify(card, null, 1));
    else {
      out(`session ${card.session}: ${card.completed_runs} steps done`);
      out(`last: ${card.last_tool} ${card.last_run} exit=${card.last_exit}`);
      if (card.last_failure) out(`last failure: ${card.last_failure.tool} ${card.last_failure.run_id} exit=${card.last_failure.exit}`);
      out(`cwd: ${card.cwd}`);
      out(`audit: ${card.audit_ok ? "ok" : "gap=" + card.audit_gap}`);
      out(card.resume_hint);
    }
    return card.audit_ok ? 0 : 1;
  } catch (e: any) {
    err(e?.message || String(e));
    return 42;
  }
}

async function runCli(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;
  const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
  const session = flag(flags, "--session") || process.env.DIA_SESSION;
  if (!session) { err("missing --session (or DIA_SESSION)"); return 2; }
  if (!cmd.length) { err("usage: dia run --session S -- <cmd> [args...]"); return 2; }
  const r = runWrapped(cmd, {
    session,
    tool: flag(flags, "--tool"),
    agent: flag(flags, "--agent") || null,
    waive: has(flags, "--waive"),
    risk: flag(flags, "--risk") ? Number(flag(flags, "--risk")) : undefined,
    redline: has(flags, "--redline"),
    cwd: flag(flags, "--cwd"),
    json: has(flags, "--json"),
  });
  if (has(flags, "--json")) out(JSON.stringify(r));
  else if (r.frozen_before) err("refused: system is frozen (run `dia freeze status`)");
  return r.exit;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") { help(); return 0; }
  if (cmd === "version" || cmd === "--version") { out("dia 0.0.1"); return 0; }
  if (cmd === "kb") return kb(argv.slice(1));
  if (cmd === "ingest") return ingestCli(argv.slice(1));
  if (cmd === "audit") return auditCli(argv.slice(1));
  if (cmd === "freeze") return freezeCli(argv.slice(1));
  if (cmd === "guard") return guardCli(argv.slice(1));
  if (cmd === "run") return runCli(argv.slice(1));
  if (cmd === "resume") return resumeCli(argv.slice(1));
  if (cmd === "persona") return personaCli(argv.slice(1));
  if (cmd === "task") return taskCli(argv.slice(1));
  if (cmd === "team") return teamCli(argv.slice(1));
  if (cmd === "job") return runJob(argv.slice(1));
  if (cmd === "price") {
    const table = loadPrices();
    if (has(argv.slice(1), "--json")) out(JSON.stringify(table, null, 1));
    else for (const [m, p] of Object.entries(table)) out(`${m}	${p ? `$${p.input}/$${p.output} per Mtok` : "unpriced"}`);
    return 0;
  }
  err(`unknown command: ${cmd}`);
  help();
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  err(e?.message || String(e));
  process.exit(1);
});
