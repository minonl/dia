import { buildIndex, search, lint, getDoc, resolveKbPath } from "@dia/kb";
import { ingest, readGitUpdates } from "../../../src/ingest.ts";
import * as audit from "../../../src/audit.ts";
import * as freeze from "../../../src/freeze.ts";
import { runWrapped } from "../../../src/run.ts";
import { countCalls } from "../../../src/runtime.ts";
import { resumeCard } from "../../../src/resume.ts";
import * as persona from "../../../src/persona.ts";
import * as msg from "../../../src/msg.ts";
import * as paths from "../../../src/paths.ts";
import * as agents from "../../../src/agents.ts";
import * as tmux from "../../../src/tmux.ts";
import * as msgAcp from "../../../src/msg-acp.ts";
import * as kit from "../../../src/kit.ts";
import * as scope from "../../../src/scope.ts";
import * as active from "../../../src/active.ts";
import * as doctor from "../../../src/doctor.ts";
import * as envx from "../../../src/env.ts";
import * as bw from "../../../src/bw.ts";
import * as deps from "../../../src/deps.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import * as task from "../../../src/task.ts";
import * as team from "../../../src/team.ts";
import { loadPrices } from "../../../src/pricing.ts";
import { propose } from "../../../src/proposal.ts";
import { runJob } from "../../../src/job.ts";

function out(s: string) { process.stdout.write(s + "\n"); }
function err(s: string) { process.stderr.write(s + "\n"); }

/** 版本号以 package.json 为准；dev（src）与 npm/install（dist）两种层级都兼容。 */
function cliVersion(): string {
  const candidates = [
    new URL("../../../package.json", import.meta.url),
    new URL("../package.json", import.meta.url),
  ];
  for (const u of candidates) {
    try { return String(JSON.parse(readFileSync(u, "utf8")).version || "0.0.0"); } catch { /* next */ }
  }
  return "0.0.0";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(name); }
/** 取某个 flag 的全部出现（如 \`--map\` 可重复）。 */
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]);
  return out;
}
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
  dia audit verify --session S --calls N [--chain] [--json]
  dia audit score --session S [--json]
  dia audit tail [--n 20] [--json]
  dia freeze --reason R [--auto] [--last-episode ID] [--json]
  dia freeze status
  dia freeze thaw --reason R --i-am-human
  dia guard [--once] [--json]
  dia run --session S [--tool T] [--agent A] [--waive --risk N] [--redline] -- <cmd> [args...]
  dia resume --session S [--json]
  dia persona add <id|--from SRC> [--ref REF] [--host opencode|dsh|codex] [--home DIR] [--dry-run] [--force] [--json]
  dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--dry-run] [--json]
  dia persona render <id> [--host opencode|dsh|codex] [--home DIR] [--check] [--json]
  dia persona list|verify|remove|show <id>|use <id>[@ver]
  dia persona path [<id>[@<ver>]] [--json]   # 打印生效版本目录（服务/脚本取代码入口）
  dia persona check <id>|update <id> [--ref REF]
  dia doctor [--persona ID] [--paths] [--json]
  dia deps list [--json] [--file PATH]        # 派生视图：登记 + 实测
  dia deps record --id ID --kind K --version V [--resolved R] [--role required|optional] [--result pass|fail|unknown] [--evidence P]
  dia env list|check [KEY…] | env [--dry-run] [--redact] <cmd…>
  dia env bw status|unlock [--passwordfile P]|lock
  dia env bw run --map KEY=item [--map …] [--task T] -- <cmd…>   # 只注入映射键；BW_SESSION 不进子进程
  dia env bw serve [--socket PATH] [--passwordfile P]   # 常驻 broker（可启动时解锁）
  dia env bw get --item ITEM [--env KEY] [--task T] [--json]
  dia persona default <id>|--unset|--show [--host opencode]
  dia kit add --from SRC [--ref REF] [--dry-run] [--json]
  dia kit list|verify <id>|remove <id>
  dia wt create|form|list|status|check|route|scope|clean|prune-merged …
  dia cmd <name> [args…]              # 只查 persona 声明的命令（可绕开同名内置）
  dia <persona-cmd> [args…]           # 一级委派（内置优先）
  dia msg send|show|inbox|ack|delivered|deliver [--wait]|reply|needs-info|status|stuck|thread|escalate|agents\n  dia agents list|register|unregister|discover\n  dia msg deliver <agent> <id> [--transport tmux|acp]\n  dia task add|list|status|done
  dia team run <id> --mock | --acp|--dsh --workspace DIR
  dia team gate|accept|reject|next
  dia team accept <id> [--note ...] [--pr N [--repo R] [--merge]]   # --pr：先验 CI，绿才接受/合并
  dia job <list|status|install|...>   # 调度适配器
  dia price list|--json
  dia version
  dia update [--check]                  # 查/装 npm 最新版`);
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
    const chained = has(args, "--chain");
    const r = audit.verify(session, calls, { chain: chained });
    const chain = r.chain;
    const p = chain?.protection;
    const protect = p
      ? ` protection=${p.state}${p.verdict ? ":" + p.verdict : ""}${p.fatal ? " (failing closed)" : ""}`
        + (p.path ? ` checkpoint=${p.path}` : "")
      : "";
    const extra = chained && chain
      ? ` chain=${chain.ok ? "ok" : "broken" + (chain.broken_at !== null ? "@" + chain.broken_at : "") + " " + chain.reason}`
        + ` checked=${chain.checked} legacy=${chain.legacy} head=${chain.head_seq ?? "-"}`
        + (chain.tail_truncated ? " tail_truncated=true" : "")
        + protect
      : "";
    out(asJson ? JSON.stringify({ ...r, expected_source: auto ? "runtime" : "manual" })
      : `audit_rows=${r.audit_rows} expected=${r.expected_calls} (${auto ? "runtime" : "manual"}) ok=${r.ok} gap=${r.gap}${extra}`);
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



async function agentsCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  try {
    if (!sub || sub === "list") {
      const rows = agents.list({ live: has(args, "--live") });
      out(asJson ? JSON.stringify(rows, null, 1)
        : rows.map((r) => `${r.agent}\t${r.live ? "live" : "offline"}${r.mismatch ? "(!mismatch)" : ""}\t${r.host}\t${r.pane ?? "-"}\t${r.cwd ?? "-"}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "register") {
      const agent = flag(args, "--agent") || positional(args)[0];
      if (!agent) { err("usage: dia agents register --agent X --host codex [--pane %3] [--cwd DIR]"); return 2; }
      const r = agents.register({ agent, host: flag(args, "--host") || "codex", pane: flag(args, "--pane"), cwd: flag(args, "--cwd"), session: flag(args, "--session"), acp_cmd: flag(args, "--acp-cmd"), pid: flag(args, "--pid") ? Number(flag(args, "--pid")) : undefined });
      out(asJson ? JSON.stringify(r) : `registered ${r.agent} (${r.host}) pane=${r.pane ?? "-"}`);
      return 0;
    }
    if (sub === "unregister") {
      const agent = positional(args)[0];
      if (!agent) { err("usage: dia agents unregister <agent>"); return 2; }
      out(agents.unregister(agent) ? `unregistered ${agent}` : `(not found) ${agent}`);
      return 0;
    }
    if (sub === "discover") {
      const rows = agents.discoverTmux();
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((r) => `${r.agent}\t${r.session}\t${r.pane}\t${r.cwd}`).join("\n") || "(none)");
      return 0;
    }
  } catch (e: any) { err(e?.message || String(e)); return 31; }
  err("usage: dia agents list|register|unregister|discover");
  return 2;
}

async function waitTerminal(id: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = msg.find(id);
    if (hit && msg.isTerminal(hit.msg.state)) return hit.msg.state;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "timeout";
}

function spawnDetachedDelivery(args: string[]): { pid?: number; log: string } {
  const root = msg.msgRoot();
  const agent = positional(args)[0] || "unknown";
  const id = positional(args)[1] || `unknown-${Date.now()}`;
  const dir = join(root, agent);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `deliver-${id}.log`);
  const fd = openSync(log, "a");
  const bin = process.argv[1];
  const child = spawn(process.execPath, [bin, "msg", "deliver", ...args, "--wait"], {
    detached: true, stdio: ["ignore", fd, fd], env: process.env,
  });
  child.unref();
  return { pid: child.pid, log };
}

async function msgCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  const refs: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref" && args[i + 1]) { const [k, ...v] = args[i + 1].split("="); if (k && v.length) refs[k] = v.join("="); i++; }
  }
  try {
    if (sub === "send") {
      const to = positional(args)[0];
      const from = flag(args, "--from") || process.env.DIA_AGENT || process.env.DIA_PERSONA;
      if (!to || !from) { err("usage: dia msg send <to> --from <me> --kind <k> --subject S [--body B|--body-file F]"); return 2; }
      const m = msg.send({
        from, to,
        kind: (flag(args, "--kind") || "notify") as any,
        subject: flag(args, "--subject") || "",
        body: flag(args, "--body"),
        bodyFile: flag(args, "--body-file"),
        refs: Object.keys(refs).length ? refs : undefined,
        requiresReply: has(args, "--requires-reply") ? true : undefined,
        deadline: flag(args, "--deadline"),
        threadId: flag(args, "--thread"),
        hops: flag(args, "--hops") ? Number(flag(args, "--hops")) : undefined,
      });
      out(asJson ? JSON.stringify(m) : `${m.id}\t${m.thread_id}#${m.seq}\t${m.from} → ${m.to}\t${m.kind}\t${m.subject}`);
      return 0;
    }
    if (sub === "needs-info") {
      const [agent, id] = positional(args);
      if (!agent || !id) { err("usage: dia msg needs-info <agent> <id> --reason \"...\""); return 2; }
      const m = msg.needsInfo(agent, id, flag(args, "--reason") || "");
      out(asJson ? JSON.stringify(m) : `${m.id}\t${m.state}`);
      return 0;
    }
    if (sub === "status") {
      const id = positional(args)[0];
      if (!id) { err("usage: dia msg status <id> [--json]"); return 2; }
      const hit = msg.find(id);
      if (!hit) { err(`E_NOT_FOUND: ${id}`); return 21; }
      const age = Math.round((Date.now() - new Date(hit.msg.created_at).getTime()) / 1000);
      out(asJson ? JSON.stringify({ agent: hit.agent, ...hit.msg, age_s: age }, null, 1)
        : `${hit.msg.id}\t${hit.msg.state}\t${hit.agent}\t${hit.msg.kind}\t${hit.msg.subject}\tage=${age}s${msg.isTerminal(hit.msg.state) ? "" : "  (处理中)"}`);
      return 0;
    }
    if (sub === "stuck") {
      const rows = msg.stuck(Number(flag(args, "--minutes") || 30));
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((m) => `${m.id}\t${m.state}\t${m.to}\t${m.subject}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "show") {
      const [agent, id] = positional(args);
      if (!agent || !id) { err("usage: dia msg show <agent> <id>"); return 2; }
      const m = msg.get(agent, id);
      const body = m.body_file ? `(见文件) ${m.body_file}` : (m.body ?? "");
      out(asJson ? JSON.stringify(m, null, 1) : `${m.id}  [${m.state}]  ${m.from} → ${m.to}  ${m.kind}\n主题: ${m.subject}\n${body}`);
      return 0;
    }
    if (sub === "deliver") {
      const [agent, id] = positional(args);
      if (!agent || !id) { err("usage: dia msg deliver <agent> <id> [--transport tmux|acp] [--wait] [--force]"); return 2; }
      const transport = flag(args, "--transport") || "tmux";
      // 默认异步：投递即返回，回执走 dia msg reply / 状态机；长任务不再阻塞调用方。
      // 但目标必须**先校验**（离线/身份不符直接报错，不能把错误留给后台子进程吞掉）。
      if (!has(args, "--wait") && transport === "tmux") {
        try { agents.resolveTarget(agent); }
        catch (e: any) { err(String(e?.message || e)); return 1; }
      }
      if (!has(args, "--wait")) {
        const child = spawnDetachedDelivery(args);
        out(asJson ? JSON.stringify({ dispatched: true, pid: child.pid, agent, id, transport, log: child.log })
                   : `dispatched ${id} → ${agent}（${transport}，异步 ${child.pid}；日志 ${child.log}）`);
        return 0;
      }
      let r: any;
      if (transport === "acp") {
        r = await msgAcp.deliverAcp(agent, id);
        if (!asJson) out(`delivered ${r.id} → ${r.agent} (acp)${r.reply ? `\nreply: ${r.reply.slice(0, 200)}` : ""}`);
      } else {
        r = tmux.deliver(agent, id, { force: has(args, "--force") });
        if (!asJson) out(`delivered ${r.id} → ${r.agent} (${r.pane})`);
      }
      // --wait：等的是**终态**（replied/needs_info/closed/escalated），不是 ACP 回合结束
      const finalState = await waitTerminal(id, Number(flag(args, "--timeout") || process.env.DIA_MSG_WAIT_MS || 600_000));
      if (asJson) out(JSON.stringify({ ...r, state: finalState }));
      else out(`state=${finalState}${finalState === "timeout" ? "（仍在处理，可 dia msg status 查看）" : ""}`);
      return finalState === "timeout" ? 7 : 0;
    }
    if (sub === "inbox") {
      const agent = positional(args)[0];
      if (!agent) { err("usage: dia msg inbox <agent> [--unread]"); return 2; }
      const rows = msg.inbox(agent, { unread: has(args, "--unread") });
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((m) => `${m.id}\t${m.state}\t${m.from}\t${m.subject}`).join("\n") || "(empty)");
      return 0;
    }
    if (sub === "ack") {
      const [agent, id] = positional(args);
      if (!agent || !id) { err("usage: dia msg ack <agent> <id>"); return 2; }
      const m = msg.ack(agent, id);
      out(asJson ? JSON.stringify(m) : `${m.id}\t${m.state}`);
      return 0;
    }
    if (sub === "delivered") {
      const [agent, id] = positional(args);
      const transport = flag(args, "--transport") || "unknown";
      if (!agent || !id) { err("usage: dia msg delivered <agent> <id> --transport tmux|acp"); return 2; }
      const m = msg.markDelivered(agent, id, transport);
      out(asJson ? JSON.stringify(m) : `${m.id}\t${m.state}\t${m.transport}`);
      return 0;
    }
    if (sub === "reply") {
      const [agent, id] = positional(args);
      if (!agent || !id) { err("usage: dia msg reply <agent> <id> --body B"); return 2; }
      const r = msg.reply(agent, id, flag(args, "--body") || "", { refs: Object.keys(refs).length ? refs : undefined });
      out(asJson ? JSON.stringify(r) : `${r.reply.id}\t${r.reply.thread_id}#${r.reply.seq}\t${r.reply.from} → ${r.reply.to}`);
      return 0;
    }
    if (sub === "thread") {
      const tid = positional(args)[0];
      if (!tid) { err("usage: dia msg thread <thread_id>"); return 2; }
      const rows = msg.thread(tid);
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((m) => `${m.id}\t${m.state}\t${m.from} → ${m.to}\t${m.kind}\t${m.subject}`).join("\n") || "(empty)");
      return 0;
    }
    if (sub === "escalate") {
      const rows = msg.escalateOverdue();
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((m) => `${m.id}\t${m.to}\t${m.subject}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "agents") {
      const rows = msg.agents();
      out(asJson ? JSON.stringify(rows) : rows.join("\n") || "(none)");
      return 0;
    }
  } catch (e: any) {
    const m = e?.message || String(e);
    err(m);
    if (m.startsWith("E_NOT_FOUND")) return 21;
    if (m.startsWith("E_USAGE")) return 2;
    return 31;
  }
  err("usage: dia msg send|inbox|ack|delivered|reply|thread|escalate|agents");
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
    if (sub === "gate" || sub === "accept" || sub === "reject") {
      if (!id) { err(`usage: dia team ${sub} <task-id>${sub === "accept" ? " [--note ...] [--pr N [--repo R] [--merge]]" : ""}`); return 2; }
    }
    if (sub === "gate") {
      const g = team.gate(id);
      out(asJson ? JSON.stringify(g) : (g.ok ? "gate ok" : "gate fail: " + g.reason));
      return g.ok ? 0 : 30;
    }
    if (sub === "accept") {
      const t = team.accept(id, flag(args, "--note"), { pr: flag(args, "--pr"), repo: flag(args, "--repo"), merge: has(args, "--merge") });
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
      const r = persona.install(from, { ref: flag(args, "--ref"), host: flag(args, "--host"), home: flag(args, "--home"), dryRun: has(args, "--dry-run"), force: has(args, "--force") });
      out(asJson ? JSON.stringify(r) : `installed ${r.id}@${r.version} -> ${r.rendered.join(", ") || "(dry-run)"}` +
        (r.overwrites?.length ? `\n  ⚠ 覆盖 ${r.overwrites.length} 个已存在产物（已备份）：${r.overwrites.join(", ")}` : ""));
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
      const resolved = ver ? persona.resolveVersion(id, ver) : null;
      const r = active.use(id, resolved || (has(args, "--latest") ? null : null), { reason: flag(args, "--reason") });
      out(asJson ? JSON.stringify(r) : `${id}: ${r.previous ?? "(未设置)"} → ${r.current.version}（${r.current.commit ?? "?"}, by ${r.current.by}）`);
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return String(e?.message || "").startsWith("E_VERSION") ? 21 : 31;
    }
  }
  if (sub === "gc") {
    const id = positional(args)[0];
    if (!id) { err("usage: dia persona gc <id> [--keep N] [--dry-run] [--json]"); return 2; }
    try {
      const r = persona.gc(id, { keep: Number(flag(args, "--keep") || 3), dryRun: has(args, "--dry-run") });
      out(asJson ? JSON.stringify(r)
        : `kept: ${r.kept.join(", ") || "-"}\nremoved: ${r.removed.join(", ") || "-"}${has(args, "--dry-run") ? "（dry-run，未删除）" : ""}`);
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return String(e?.message || "").startsWith("E_NOT_INSTALLED") ? 20 : 31;
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
    if (!id) { err("usage: dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--dry-run] [--json]"); return 2; }
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
    if (!id) { err("usage: dia persona render <id> [--host opencode|dsh|codex] [--home DIR] [--check] [--json]"); return 2; }
    try {
      const r = persona.render(id, { host: flag(args, "--host"), home: flag(args, "--home"), check: has(args, "--check") });
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
  const home = resolvePath(paths.installDir(), "packages/wt/bin/dia-wt");
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
  if (cmd === "version" || cmd === "--version") { out(`dia ${cliVersion()}`); return 0; }
  if (cmd === "update") {
    const check = has(argv, "--check");
    const cur = cliVersion();
    let latest = "", next = "";
    try {
      const raw = execFileSync("npm", ["view", "@minonl/dia", "dist-tags", "--json"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
      const parsed = JSON.parse(raw || "{}");
      // npm view --json 对 dist-tags 返回数组（[{"latest":...}]），对象形态也兼容
      const tags = Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
      latest = String(tags.latest || ""); next = String(tags.next || "");
    } catch (e: any) {
      err(`E_UPDATE: 查不到 registry 版本（${String(e?.message || e).split("\n")[0]}）`);
      return 1;
    }
    const cmp = (a: string, b: string) => {
      const pa = a.split(/[.-]/).slice(0, 3).map(Number), pb = b.split(/[.-]/).slice(0, 3).map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      return 0;
    };
    const ahead = latest && cmp(cur, latest) > 0;
    const install = paths.installDir();
    const npmManaged = install.split(/[\\/]/).includes("node_modules") && install.includes("@minonl");
    out(`当前 ${cur}｜latest ${latest || "-"}｜next ${next || "-"}${ahead ? "（当前领先 latest）" : ""}`);
    out(`安装目录 ${install}（${npmManaged ? "npm 全局包" : "脚本安装"}）`);
    if (check) return latest && !ahead && latest !== cur ? 1 : 0;
    if (latest && (latest === cur || ahead)) { out(ahead ? "当前版本领先 latest（预发布）" : "已是最新"); return 0; }
    if (!npmManaged) {
      // 脚本安装（install.sh）→ npm 装到全局 prefix 可能不在 PATH 上，别做无效升级
      let source = "";
      try { source = String(JSON.parse(readFileSync(join(install, "install.json"), "utf8")).source || ""); } catch {}
      out(`这是脚本安装，不走 npm 升级。升级方式：`);
      out(`  cd ${source || "<dia 仓库>"} && git pull && bun run build && bash install.sh`);
      out(`（或改用 npm 全局安装：npm i -g @minonl/dia@latest）`);
      return 0;
    }
    const r = spawnSync("npm", ["i", "-g", "@minonl/dia@latest"], { stdio: "inherit" });
    if (r.status !== 0) { err("E_UPDATE: npm 安装失败（可能需要 sudo 或调整 npm prefix）"); return r.status || 1; }
    out(`已更新到 ${latest}（重新打开终端/会话生效）`);
    return 0;
  }
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
      if (sub === "bw") {
        const [act = "status", ...rest2] = rest;
        try {
          if (act === "status") {
            const s = bw.status();
            if (has(rest2, "--json")) out(JSON.stringify(s));
            else out(`${s.status}${s.detail ? "（" + s.detail + "）" : ""}`);
            return s.status === "unlocked" ? 0 : 1;
          }
          if (act === "unlock") {
            const r = bw.unlock({ passwordFile: flag(rest2, "--passwordfile") });
            if (!r.ok) { err(r.error); return 1; }
            out("unlocked（session 已落盘 0600，不显示）");
            return 0;
          }
          if (act === "lock") {
            const r = bw.lock();
            if (!r.ok) { err("E_BW: " + r.error); return 1; }
            out("locked");
            return 0;
          }
          if (act === "run") {
            const maps = bw.parseMaps(flags(rest2, "--map"));
            if (!maps.length) { err("usage: dia env bw run --map KEY=item [--map …] [--task T] -- <cmd…>"); return 2; }
            const sep = rest2.indexOf("--");
            if (sep < 0 || sep === rest2.length - 1) { err("missing -- <cmd…>"); return 2; }
            const [command, ...cmdArgs] = rest2.slice(sep + 1);
            const extra = await bw.resolveMaps(maps, flag(rest2, "--task"));
            const r = bw.runWithEnv(extra, command, cmdArgs);
            process.stdout.write(r.out);
            process.stderr.write(r.err);
            return r.code;
          }
          if (act === "serve") {
            const pw = flag(rest2, "--passwordfile");
            if (pw) {
              const u = bw.unlock({ passwordFile: pw });
              if (!u.ok) { err(u.error); return 1; }
            }
            const h = await bw.serve({ socket: flag(rest2, "--socket"), ready: () => out(`broker listening ${bw.socketFile()}`) });
            process.on("SIGINT", () => { h.close(); process.exit(0); });
            process.on("SIGTERM", () => { h.close(); process.exit(0); });
            await new Promise(() => { /* keep alive; server holds the loop */ });
            return 0;
          }
          if (act === "get") {
            const item = flag(rest2, "--item");
            if (!item) { err("usage: dia env bw get --item ITEM [--env KEY] [--task T]"); return 2; }
            const viaBroker = await bw.askBroker({ env: flag(rest2, "--env"), item, task: flag(rest2, "--task") }).catch(() => null);
            const value = viaBroker ?? bw.getItemPassword(item);
            if (has(rest2, "--json")) out(JSON.stringify({ item, ok: true }));
            else out(value); // 仅调用方管道消费；日志/截图不要捕获
            return 0;
          }
          err("usage: dia env bw status|unlock|lock|run");
          return 2;
        } catch (e: any) { err(e?.message || String(e)); return 1; }
      }
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
      const bwMaps = bw.parseMaps(flags(args, "--bw"));
      // 去掉 dia 自己的 flag 与其值，剩下的才是要执行的命令
      const valueFlags = new Set(["--files", "--keys", "--bw", "--task", "--persona"]);
      const cleaned: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--dry-run" || a === "--redact" || a === "--") continue;
        if (valueFlags.has(a)) { i++; continue; }
        if (a.startsWith("--files=") || a.startsWith("--keys=") || a.startsWith("--bw=") || a.startsWith("--task=")) continue;
        cleaned.push(a);
      }
      if (!cleaned.length) { err("usage: dia env run [--dry-run] [--redact] [--bw KEY=item …] <cmd…>"); return 2; }
      const extraEnv = bwMaps.length ? await bw.resolveMaps(bwMaps, flag(args, "--task")) : undefined;
      const r = envx.run(cfg, cleaned, { dryRun: dry, redact, extraEnv });
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
    if (has(argv, "--paths")) {
      const roots = {
        install: paths.installDir(),
        data: paths.diaHome(), personas: paths.personasDir(), msg: paths.msgRoot(),
        agents: paths.agentsRoot(), state: paths.stateDir(), cache: paths.cacheRoot(), job: paths.jobRoot(),
      };
      out(has(argv, "--json") ? JSON.stringify(roots, null, 1) : Object.entries(roots).map(([k, v]) => `${k.padEnd(9)} ${v}`).join("\n"));
      return 0;
    }
    const r = await doctor.run({ persona: flag(argv, "--persona") });
    if (has(argv, "--json")) out(JSON.stringify(r, null, 1));
    else {
      for (const c of r.checks) out(`${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.name.padEnd(20)} ${c.detail}`);
      out(`verdict: ${r.verdict}`);
    }
    return r.verdict === "ok" ? 0 : r.verdict === "warn" ? 1 : 2;
  }
  if (cmd === "deps") {
    const [sub = "list", ...rest] = argv.slice(1);
    const asJson = has(rest, "--json");
    const file = flag(rest, "--file");
    if (sub === "list") {
      const rows = deps.load(file).map((e: any) => ({ ...e, check: deps.check(e) }));
      if (asJson) out(JSON.stringify(rows, null, 1));
      else if (!rows.length) out("（无登记）");
      else for (const r of rows) out(`${r.check.status === "ok" ? "✓" : r.check.status === "warn" ? "!" : "✗"} ${r.check.detail}`);
      return rows.some((r: any) => r.check.status === "fail") ? 2 : 0;
    }
    if (sub === "record") {
      const id = flag(rest, "--id"), kind = flag(rest, "--kind"), version = flag(rest, "--version");
      if (!id || !kind || !version) {
        err("usage: dia deps record --id <kind:name@ver> --kind <host_cli|npm|bundle|datastore|model> --version <ver> [--resolved R] [--role required|optional] [--result pass|fail|unknown] [--evidence P] [--fallback X] [--integrity I] [--removal-after DATE] [--file PATH]");
        return 2;
      }
      const entry: deps.DepEntry = {
        id, kind, version,
        resolved: flag(rest, "--resolved"),
        integrity: flag(rest, "--integrity") || "unknown",
        role: flag(rest, "--role") || "optional",
        fallback: flag(rest, "--fallback"),
        verified_at: new Date().toISOString().slice(0, 10),
        verified_by: process.env.USER || "cli",
        method: "manual",
        result: flag(rest, "--result") || "unknown",
        support: "active",
        removal_after: flag(rest, "--removal-after"),
        evidence: flag(rest, "--evidence"),
      } as deps.DepEntry;
      for (const k of Object.keys(entry) as (keyof deps.DepEntry)[]) if (entry[k] === undefined) delete (entry as any)[k];
      const path = deps.append(entry, file);
      out(asJson ? JSON.stringify(entry) : `recorded ${id} -> ${path}`);
      return 0;
    }
    err("usage: dia deps list|record");
    return 2;
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
  if (cmd === "msg") return msgCli(argv.slice(1));
  if (cmd === "agents") return agentsCli(argv.slice(1));
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
