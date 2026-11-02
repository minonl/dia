import { buildIndex, search, lint, getDoc, resolveKbPath } from "@dia/kb";
import { ingest, readGitUpdates } from "../../../src/ingest.ts";
import * as audit from "../../../src/audit.ts";
import * as freeze from "../../../src/freeze.ts";
import { runWrapped } from "../../../src/run.ts";
import { countCalls } from "../../../src/runtime.ts";
import { resumeCard } from "../../../src/resume.ts";
import * as persona from "../../../src/persona.ts";
import * as kit from "../../../src/kit.ts";
import * as scope from "../../../src/scope.ts";
import * as active from "../../../src/active.ts";
import * as doctor from "../../../src/doctor.ts";
import * as envx from "../../../src/env.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import * as task from "../../../src/task.ts";
import * as team from "../../../src/team.ts";
import { loadPrices } from "../../../src/pricing.ts";
import { propose } from "../../../src/proposal.ts";
import { runJob } from "../../../src/job.ts";

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
    if (args[i].startsWith("--")) { if (!args[i].includes("=") && args[i] !== "--auto-index") i++; continue; }
    out.push(args[i]);
  }
  return out;
}
function safeScope(explicit?: string): scope.Scope | null {
  try { return scope.current(explicit); }
  catch (e: any) {
    // 显式指定却没装 → 必须报错；多 persona 未指定 → 退回无作用域
    if (String(e?.message || "").includes("not installed")) throw e;
    return null;
  }
}

function rootOf(args: string[]): string {
  const explicit = flag(args, "--root") || process.env.DIA_KB_ROOT;
  if (explicit) return explicit;
  const sc = safeScope(flag(args, "--persona"));
  if (sc?.knowledgeRoot) return sc.knowledgeRoot;
  return process.cwd();
}

/** 域命令委派：把 `<name> <args…>` 交给 persona 声明的可执行（argv 透传，exit code 原样）。 */
function delegatePersonaCommand(name: string, args: string[], opts: { onlyExternal?: boolean } = {}): number | null {
  const sc = safeScope(flag(args, "--persona"));
  if (!sc) return null;
  for (const k of sc.kits) {
    const c = k.commands.find((x) => x.name === name);
    if (!c) continue;
    const kroot = resolvePath(k.root);
    const entry = resolvePath(kroot, c.entry);
    // 命令入口必须在 persona/kit 根内：绝对路径或 ../ 穿越一律拒绝。
    if (entry !== kroot && !entry.startsWith(kroot + pathSep)) {
      err(`E_DELEGATE_SCOPE: ${name}: 入口越出 persona 根（${c.entry}）`);
      return 31;
    }
    // bash：直接把入口当可执行脚本调，**不注入命令名**（脚本自己解析子命令）。
    const isBash = c.runtime === "bash";
    const runtime = isBash ? "bash"
      : c.runtime === "node" ? "node"
      : c.runtime === "bun" ? "bun"
      : (typeof (globalThis as any).Bun !== "undefined" ? "bun" : "node");
    const argv = isBash ? [entry, ...args] : [entry, name, ...args];
    const r = spawnSync(runtime, argv, {
      stdio: "inherit",
      env: { ...process.env, ...scope.scopeEnv(sc, c.env ?? {}) },
    });
    if (r.error) { err(`E_DELEGATE: ${name}: ${r.error.message}`); return 31; }
    return r.status ?? 1;
  }
  void opts;
  return null;
}

/** kb 子命令委派（`dia kb <sub>` 用）。 */
function delegateKb(sub: string, args: string[]): number | null {
  return delegatePersonaCommand(sub, args);
}

/** persona 声明的全部一级命令名（用于未知命令提示与 `dia cmd` 兜底）。 */
function personaCommandNames(): string[] {
  const sc = safeScope(undefined);
  if (!sc) return [];
  return sc.kits.flatMap((k) => k.commands.map((c) => c.name));
}

function help() {
  out(`dia (嗲) — agent framework

usage:
  dia kb index [--root DIR] [--db PATH] [--json]
  dia kb search <query> [--root DIR] [--db PATH] [--limit N] [--json]
  dia kb query <query> [--root DIR] [--db PATH] [--limit N] [--json] [--full] [--bytes] [--auto-index]
  dia kb review [--root DIR] [--db PATH] [--json]
  dia kb path <doc:...|workflow:...|skill:...|tool:...#mode> [--root DIR] [--repo DIR] [--json]
  dia kb lint [--root DIR] [--db PATH] [--stale-days N] [--json] [--strict]
  dia kb get <path> [--root DIR] [--section HEADING]
  dia --persona ID kb <cmd>   # persona 作用域：知识根/数据根/域命令委派
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
  dia persona create <id> --dir DIR [--host opencode|dsh] [--dry-run] [--json]
  dia persona render <id> [--host opencode|dsh] [--check] [--json]
  dia persona list|verify|remove|show <id>|use <id>[@ver]
  dia persona path [<id>[@<ver>]] [--json]   # 打印生效版本目录（服务/脚本取代码入口）
  dia persona check <id>|update <id> [--ref REF]
  dia doctor [--persona ID] [--json]
  dia env list|check [KEY…] | env [--dry-run] [--redact] <cmd…>
  dia persona default <id>|--unset|--show [--host opencode]
  dia kit add --from SRC [--ref REF] [--dry-run] [--json]
  dia kit list|verify <id>|remove <id>
  dia wt create|form|list|status|check|route|scope|clean|prune-merged …
  dia cmd <name> [args…]              # 只查 persona 声明的命令（可绕开同名内置）
  dia <persona-cmd> [args…]           # 一级委派（内置优先）
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
    if (!q) { err("missing query"); return 2; }
    const rawLimit = flag(args, "--limit");
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0) { err("--limit must be a positive integer"); return 2; }
    let rows;
    try {
      rows = await search(root, q, db, limit);
    } catch (e: any) {
      // 索引缺失或过期都自动重建（知识随 persona 更新，索引过期是常态，不该让用户手跑 index）
      const code = String(e?.code || "");
      // 显式 --root/--db 时保持「缺索引即报错」；persona 作用域下索引过期是常态 → 自动重建
      const scoped = !flag(args, "--root") && !process.env.DIA_KB_ROOT;
      if (has(args, "--auto-index") || scoped) {
        await buildIndex(root, db);
        rows = await search(root, q, db, limit);
      } else {
        throw e;
      }
    }
    const full = sub === "query" && has(args, "--full");
    const bytes = sub === "query" && has(args, "--bytes");
    const enrich = rows.map((r) => {
      const item: any = { ...r };
      try {
        if (bytes) item.bytes = Buffer.byteLength(getDoc(root, r.path), "utf8");
        if (full) item.text = getDoc(root, r.path);
      } catch {
        item.stale_index = true;
        item.text = null;
        item.bytes = null;
      }
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
  if (sub === "path") {
    const addr = positional(args)[0];
    if (!addr) { err("missing address"); return 2; }
    try {
      const resolved = resolveKbPath(root, addr, {
        repo: flag(args, "--repo") || process.env.DIA_REPO_ROOT,
        skillsDir: flag(args, "--skills-dir") || process.env.DIA_KB_SKILLS_DIR,
        runtime: flag(args, "--runtime") || process.env.DIA_KB_RUNTIME,
      });
      out(has(args, "--json") ? JSON.stringify(resolved, null, 1) : resolved.command);
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return e?.code === 4 ? 4 : 2;
    }
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
  if (sub) {
    const rc = delegateKb(sub, args);
    if (rc !== null) return rc;
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
      out(asJson ? JSON.stringify(r) : `${r.ok ? "ok" : "MISMATCH"} ${r.dir}${r.ok ? "" : `\n  - ${r.issues.join("\n  - ")}`}`);
      return r.ok ? 0 : 1;
    } catch (e: any) { err(e?.message || String(e)); return 31; }
  }
  if (sub === "use") {
    const spec = positional(args)[0];
    if (!spec) { err("usage: dia persona use <id>[@<version>] [--latest] [--reason R]"); return 2; }
    const [id, ver] = spec.split("@");
    try {
      const r = active.use(id, ver || (has(args, "--latest") ? null : null), { reason: flag(args, "--reason") });
      out(asJson ? JSON.stringify(r) : `${id}: ${r.previous ?? "(未设置)"} → ${r.current.version}（${r.current.commit ?? "?"}, by ${r.current.by}）`);
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return String(e?.message || "").startsWith("E_VERSION") ? 21 : 31;
    }
  }
  if (sub === "show") {
    const id = positional(args)[0];
    if (!id) { err("missing id"); return 2; }
    const eff = active.effective(id);
    const hist = active.history(id, 5);
    if (asJson) { out(JSON.stringify({ id, effective: eff, history: hist }, null, 1)); return 0; }
    out(`${id}: 生效 ${eff ? `${eff.version}（${eff.source === "active" ? "active 指针" : "最新安装"}）` : "(未安装)"}`);
    for (const h of hist) out(`  ${h.at}  ${h.previous ?? "-"} → ${h.version}  by ${h.by}${h.reason ? `  ${h.reason}` : ""}`);
    return 0;
  }
  // 生效版本目录：服务入口 / 脚本取代码用（2026-10-30 迁移：dws-hub 服务入口从 yan-ref 切到这里）
  // 语义：id 缺省 ⇒ 走 persona 作用域（--persona / DIA_PERSONA / 唯一已装）；版本缺省 ⇒ active 指针
  if (sub === "path") {
    const spec = positional(args)[0] || "";
    const [wantId, wantVer] = spec.split("@");
    try {
      const sc = scope.current(wantId || undefined);
      if (!sc) { err("E_SCOPE: 未安装任何 persona（先 dia persona add <id>）"); return 31; }
      const hit = persona.dirOf(sc.id, wantVer || undefined);
      if (!hit) { err(`E_VERSION: ${sc.id}@${wantVer} 未安装`); return 21; }
      const eff = active.effective(sc.id);
      const payload = {
        id: sc.id,
        version: hit.version,
        dir: hit.dir,
        source: wantVer ? "explicit" : (eff?.source ?? "latest"),
        commit: active.read(sc.id)?.commit ?? null,
      };
      out(asJson ? JSON.stringify(payload, null, 1) : hit.dir);
      return 0;
    } catch (e: any) { err(e?.message || String(e)); return 31; }
  }
  if (sub === "check") {
    const id = positional(args)[0];
    if (!id) { err("missing id"); return 2; }
    try {
      const r = persona.checkUpstream(id, flag(args, "--version"));
      if (asJson) out(JSON.stringify(r, null, 1));
      else {
        out(`${r.id}@${r.version}  本地 ${String(r.local_commit).slice(0, 8)}  上游 ${r.upstream_commit ? String(r.upstream_commit).slice(0, 8) : "(未知)"}  → ${r.relation}`);
        out(`  内容校验：${r.verify_ok ? "ok" : "MISMATCH"}`);
        out(`  来源：${r.source ?? "(本地目录)"}${r.ref ? ` @ ${r.ref}` : ""}`);
      }
      // 0 一致；1 有更新；2 内容被改；3 无法判定
      if (!r.verify_ok) return 2;
      if (r.relation === "same" || r.relation === "local-only") return 0;
      if (r.relation === "differs") return 1;
      return 3;
    } catch (e: any) { err(e?.message || String(e)); return 31; }
  }
  if (sub === "update") {
    const id = positional(args)[0];
    if (!id) { err("missing id"); return 2; }
    try {
      const r = persona.update(id, { ref: flag(args, "--ref") });
      out(asJson ? JSON.stringify(r) : `updated ${id} → ${r.installed.version}（${String(r.installed.commit || r.installed.hash || "?").slice(0, 8)}, 原 ${r.previous ?? "-"}）`);
      return 0;
    } catch (e: any) {
      const m = e?.message || String(e);
      err(m);
      return m.startsWith("E_SOURCE") ? 34 : 31;
    }
  }
  if (sub === "default") {
    const id = positional(args)[0] || null;
    try {
      if (has(args, "--show") || (!id && !has(args, "--unset"))) {
        const r = persona.showDefaultAgent({ host: flag(args, "--host") });
        out(asJson ? JSON.stringify(r) : `${r.current ?? "(未设置)"}  <- ${r.file}`);
        return 0;
      }
      const r = persona.setDefaultAgent(has(args, "--unset") ? null : id, { host: flag(args, "--host") });
      out(asJson ? JSON.stringify(r) : `${has(args, "--unset") ? "unset" : `default_agent = ${r.current}`}（原 ${r.previous ?? "未设置"}；备份 ${r.backup}）`);
      return 0;
    } catch (e: any) {
      const m = e?.message || String(e);
      err(m);
      if (m.startsWith("E_CONFIG")) return 21;
      if (m.startsWith("E_HOST")) return 33;
      return 31;
    }
  }
  if (sub === "create") {
    const id = positional(args)[0];
    if (!id) { err("usage: dia persona create <id> --dir DIR [--host opencode|dsh] [--dry-run] [--json]"); return 2; }
    try {
      const host = flag(args, "--host");
      const r = persona.create(id, { dir: flag(args, "--dir"), hosts: host ? [host] : undefined, dryRun: has(args, "--dry-run") });
      out(asJson ? JSON.stringify(r) : `${r.dryRun ? "[dry-run] " : ""}created ${r.id} -> ${r.dir}\n  ${r.files.join("\n  ")}`);
      return 0;
    } catch (e: any) {
      const m = e?.message || String(e);
      err(m);
      if (m.startsWith("E_USAGE")) return 2;
      if (m.startsWith("E_CONFLICT") || m.startsWith("E_MANIFEST")) return 32;
      if (m.startsWith("E_HOST")) return 33;
      return 31;
    }
  }
  if (sub === "render") {
    const id = positional(args)[0];
    if (!id) { err("usage: dia persona render <id> [--host opencode|dsh] [--check] [--json]"); return 2; }
    try {
      const r = persona.render(id, { host: flag(args, "--host"), check: has(args, "--check") });
      if (asJson) out(JSON.stringify(r, null, 1));
      else if (r.check) out(r.drift.length ? `drift ${r.drift.length}:\n  ${r.drift.map((d: any) => `${d.action}: ${d.path}`).join("\n  ")}` : "ok（无 drift）");
      else out(`rendered ${r.id}@${r.version}${r.drift.length ? `（修复 ${r.drift.length} 处，备份 ${r.backups.length}）` : "（无变化）"}`);
      return r.check && r.drift.length ? 1 : 0;
    } catch (e: any) {
      const m = e?.message || String(e);
      err(m);
      if (m.startsWith("E_NOT_INSTALLED")) return 21;
      if (m.startsWith("E_MANIFEST")) return 32;
      if (m.startsWith("E_HOST")) return 33;
      return 31;
    }
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
  err("usage: dia persona add|create|render|list|verify|remove|show|use|path|check|update|default");
  return 2;
}

async function kitCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  try {
    if (sub === "add") {
      const from = flag(args, "--from") || positional(args)[0];
      if (!from) { err("missing --from"); return 2; }
      const r = kit.install(from, { ref: flag(args, "--ref"), dryRun: has(args, "--dry-run") });
      out(asJson ? JSON.stringify(r)
        : `installed kit ${r.id}@${r.version} -> ${r.dir}${r.rendered.length ? `\n  ${r.rendered.map((e: any) => `${e.type}: ${e.path}`).join("\n  ")}` : ""}`);
      return 0;
    }
    if (sub === "list") {
      const rows = kit.list();
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((r: any) => `${r.id}: ${r.versions.join(", ")}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "verify") {
      const id = positional(args)[0];
      if (!id) { err("missing id"); return 2; }
      const r = kit.verify(id, flag(args, "--version"));
      out(asJson ? JSON.stringify(r) : `${r.ok ? "ok" : "MISMATCH"} ${id}@${r.version}` +
        (r.drift.length ? `\n  drift: ${r.drift.join(", ")}` : ""));
      return r.ok ? 0 : 1;
    }
    if (sub === "remove") {
      const id = positional(args)[0];
      if (!id) { err("missing id"); return 2; }
      const r = kit.remove(id);
      out(asJson ? JSON.stringify(r) : `removed kit ${id}${r.removed.length ? " (" + r.removed.join(", ") + ")" : ""}` +
        (r.skipped.length ? `\nskipped (modified/not managed): ${r.skipped.join(", ")}` : ""));
      return r.skipped.length ? 30 : 0;
    }
  } catch (e: any) {
    err(e?.message || String(e));
    const m = e?.message || "";
    if (m.startsWith("E_CONFLICT") || m.startsWith("E_MANIFEST")) return 32;
    if (m.startsWith("E_SOURCE")) return 34;
    return 31;
  }
  err("usage: dia kit add|list|verify|remove");
  return 2;
}

/** `dia wt …` → packages/wt/bin/dia-wt（bash 实现，与 dia-job 同模式）。 */
function wtCli(argv: string[]): number {
  const home = resolvePath(process.env.DIA_HOME_INSTALL || `${process.env.HOME}/.local/share/dia`, "packages/wt/bin/dia-wt");
  const candidates = [
    process.env.DIA_WT_BIN,
    home,
    resolvePath(fileURLToPath(new URL("../", import.meta.url)), "packages/wt/bin/dia-wt"),
  ].filter(Boolean) as string[];
  const bin = candidates.find((c) => existsSync(c));
  if (!bin) { err("E_WT: dia-wt 未安装（先跑 dia install.sh，或设 DIA_WT_BIN）"); return 33; }
  const r = spawnSync("bash", [bin, ...argv], { stdio: "inherit", env: process.env });
  return r.status ?? 1;
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

export async function main(rawArgv: string[]): Promise<number> {
  // 全局作用域参数：`dia --persona yan kb …` / `dia --persona=yan kb …`
  const argv = [...rawArgv];
  const pi = argv.indexOf("--persona");
  if (pi >= 0 && argv[pi + 1]) { process.env.DIA_PERSONA = argv[pi + 1]; argv.splice(pi, 2); }
  const peq = argv.find((a) => a.startsWith("--persona="));
  if (peq) { process.env.DIA_PERSONA = peq.slice("--persona=".length); argv.splice(argv.indexOf(peq), 1); }
  const [cmd] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") { help(); return 0; }
  if (cmd === "version" || cmd === "--version") { out("dia 0.0.1"); return 0; }
  if (cmd === "kb") {
    try { return await kb(argv.slice(1)); }
    catch (e: any) {
      if (String(e?.code || "").startsWith("E_INDEX_")) { err(e.message); return 3; }
      throw e;
    }
  }
  if (cmd === "ingest") return ingestCli(argv.slice(1));
  if (cmd === "audit") return auditCli(argv.slice(1));
  if (cmd === "freeze") return freezeCli(argv.slice(1));
  if (cmd === "guard") return guardCli(argv.slice(1));
  if (cmd === "run") return runCli(argv.slice(1));
  if (cmd === "resume") return resumeCli(argv.slice(1));
  if (cmd === "persona") return personaCli(argv.slice(1));
  if (cmd === "kit") return kitCli(argv.slice(1));
  if (cmd === "wt") return wtCli(argv.slice(1));
  if (cmd === "env") {
    const [sub, ...rest] = argv.slice(1);
    const sc = safeScope(flag(rest, "--persona"));
    const personaEnv = sc?.env ? { files: sc.env.files, keys: sc.env.keys } : undefined;
    const filesArg = flag(rest, "--files");
    const keysArg = flag(rest, "--keys");
    const cfg = envx.resolveConfig({
      persona: personaEnv,
      files: filesArg ? filesArg.split(":") : undefined,
      keys: keysArg ? keysArg.split(",") : undefined,
    });
    try {
      if (sub === "list" || (!sub && has(rest, "--list"))) {
        const r = envx.list(cfg);
        if (has(rest, "--json")) { out(JSON.stringify(r, null, 1)); return r.keys.every((k) => k.found) ? 0 : 1; }
        for (const f of r.files) out(`${f.exists ? "✓" : "!"} ${f.path}${f.exists ? `（${f.keys} 个键）` : "（缺失）"}`);
        for (const k of r.keys) out(`  ${k.found ? "✅" : "❌"} ${k.key}${k.found ? "" : "（未找到）"}`);
        out("（不回显值）");
        return r.keys.every((k) => k.found) ? 0 : 1;
      }
      if (sub === "check") {
        const target = positional(rest);
        const r = envx.check(cfg, target.length ? target : cfg.keys);
        for (const k of r) out(`  ${k.found ? "✅" : "❌"} ${k.key}${k.found ? `（${k.length} 字符）` : "（未找到）"}`);
        return r.every((k) => k.found) ? 0 : 1;
      }
      // run：`dia env [--dry-run] [--redact] <cmd…>`，也接受 `dia env run …`
      const args = sub === "run" ? rest : [sub, ...rest].filter((x) => x !== undefined);
      const dry = has(args, "--dry-run");
      const redact = has(args, "--redact") || process.env.DIA_ENV_REDACT === "1";
      const cmd = args.filter((a) => a !== "--dry-run" && a !== "--redact" && !a.startsWith("--files") && !a.startsWith("--keys"));
      // 去掉 --files/--keys 的值 token
      const cleaned: string[] = [];
      for (let i = 0; i < cmd.length; i++) {
        if (cmd[i] === filesArg || cmd[i] === keysArg) continue;
        cleaned.push(cmd[i]);
      }
      if (!cleaned.length) { err("usage: dia env run [--dry-run] [--redact] <cmd…>"); return 2; }
      const r = envx.run(cfg, cleaned, { dryRun: dry, redact });
      if (dry) {
        out(`将注入 ${r.injected.length} 个键到：${cleaned[0]}`);
        for (const k of r.injected) out(`  · ${k}（${envx.check(cfg, [k])[0]?.length ?? 0} 字符）`);
        if (r.missing.length) err(`未找到（不注入）：${r.missing.join(", ")}`);
        return 0;
      }
      if (r.missing.length) err(`未找到（不注入）：${r.missing.join(", ")}`);
      return r.exit;
    } catch (e: any) {
      err(e?.message || String(e));
      return String(e?.message || "").startsWith("E_CMD") ? 2 : 1;
    }
  }
  if (cmd === "doctor") {
    const r = doctor.run({ persona: flag(argv, "--persona") });
    if (has(argv, "--json")) out(JSON.stringify(r, null, 1));
    else {
      for (const c of r.checks) out(`${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.name.padEnd(20)} ${c.detail}`);
      out(`verdict: ${r.verdict}`);
    }
    return r.verdict === "ok" ? 0 : r.verdict === "warn" ? 1 : 2;
  }
  // B：`dia cmd <name>` 只查 persona（外部）命令，允许与内置同名也不回退
  if (cmd === "cmd") {
    const [name, ...rest] = argv.slice(1);
    if (!name) {
      const names = personaCommandNames();
      err(names.length ? `usage: dia cmd <name> [args…]  可用：${names.join(" | ")}` : "usage: dia cmd <name> [args…]（当前 persona 未声明任何命令）");
      return 2;
    }
    const rc = delegatePersonaCommand(name, rest);
    if (rc === null) { err(`E_CMD: persona 未声明命令 ${name}`); return 34; }
    return rc;
  }
  if (cmd === "task") return taskCli(argv.slice(1));
  if (cmd === "team") return teamCli(argv.slice(1));
  if (cmd === "job") return runJob(argv.slice(1));
  if (cmd === "price") {
    const table = loadPrices();
    if (has(argv.slice(1), "--json")) out(JSON.stringify(table, null, 1));
    else for (const [m, p] of Object.entries(table)) out(`${m}	${p ? `$${p.input}/$${p.output} per Mtok` : "unpriced"}`);
    return 0;
  }
  // A：内置命令未命中 → 查 persona 声明的一级命令（内置永远优先，不能被覆盖）
  {
    const rc = delegatePersonaCommand(cmd, argv.slice(1));
    if (rc !== null) return rc;
  }
  err(`unknown command: ${cmd}`);
  help();
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  err(e?.message || String(e));
  process.exit(1);
});
