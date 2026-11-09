import { buildIndex, search, lint, getDoc, resolveKbPath, indexStatus } from "@dia/kb";
import { ingest, readGitUpdates } from "../../../src/ingest.ts";
import * as audit from "../../../src/audit.ts";
import * as freeze from "../../../src/freeze.ts";
import { runWrapped } from "../../../src/run.ts";
import { countCalls } from "../../../src/runtime.ts";
import { resumeCard } from "../../../src/resume.ts";
import * as persona from "../../../src/persona.ts";
import * as msg from "../../../src/msg.ts";
import * as collab from "../../../src/collab.ts";
import * as claims from "../../../src/claims.ts";
import * as graph from "../../../src/graph.ts";
import * as graphTui from "../../../src/graph-tui.ts";
import * as graphHtml from "../../../src/graph-html/render.ts";
import * as plan from "../../../src/plan.ts";
import * as msgPriority from "../../../src/msg-priority.ts";
import * as observer from "../../../src/observer.ts";
import * as seats from "../../../src/seats.ts";
import * as defaultMsg from "../../../src/default-msg.ts";
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
import { cpSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import * as task from "../../../src/task.ts";
import * as team from "../../../src/team.ts";
import { loadPrices } from "../../../src/pricing.ts";
import { propose } from "../../../src/proposal.ts";
import { runJob, runJobCapture } from "../../../src/job.ts";
import * as service from "../../../src/service.ts";

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
  dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--no-msg] [--dry-run] [--json]
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
  dia service add (<--from SRC> | --dir DIR) [--ref REF] [--dry-run] [--json]
  dia service list [--json] | show <id> [--json] | verify <id|--dir DIR> [--json]
  dia service health <id> [--from-wrapper --exit N --gen G] [--json]   # 0 ok/30 degraded/1 fail/31 判据不可用/2 用法
  dia service remove <id> [--json]
  dia wt create|form|list|status|check|route|scope|clean|prune-merged …
  dia cmd <name> [args…]              # 只查 persona 声明的命令（可绕开同名内置）
  dia <persona-cmd> [args…]           # 一级委派（内置优先）
  dia collab status|enable|disable [--persona ID]   # dia-msg 默认能力开关（默认开）
  dia collab stats [--since 7d] [--by session|pair|class] [--json]   # 只读聚合（送达/回复/积压）
  dia collab board [--cached|--refresh] [--json] | observe [--interval 300] [--json]   # 一次性 tick/看板（无常驻；定时用 dia job）
  dia whoami [--json] [--name NAME]   # 当前会话身份（session id）
  dia in [--unread] [--all] [--legacy] [--class P0,P1] [--sort priority|arrival] [--expose] [--json]   # 会话收件箱（正文内联）
  dia out --to <session_id> --subject S (--body B|--body-file F) [--kind K] [--touch p1,p2] [--reply-to ID]
  dia ack <id> | dia reply <id> --body B | dia close <id> --reason R | dia show <id>
  dia msg send|show|inbox|ack|delivered|deliver [--wait]|reply|needs-info|status|stuck|thread|escalate|agents|migrate
  dia agents list|register|unregister|discover
  dia msg deliver <agent> <id> [--transport tmux|acp]
  dia task add|list|link|plan|split|status|done [--owner S] [--depends a,b] [--touches p1,p2] [--prio P1] [--start D] [--due D] [--progress 0-100]
  dia task split <id> --into "切片A,切片B" [--slice 切片A] [--role R] [--judge J] [--touches p] [--force]
  dia graph [--json] [--task t-...] [--tui [--watch] [--status S] [--owner S] [--width N] [--no-color]]
  dia graph --export-html [path] [--out path] [--now ISO] [--redact] [--all] [--limit N] [--force]
  dia graph --next [n] [--seats N] | --explain <id> | --lint   # 只读编排建议（Kahn-v1 / seats-v1）
  dia claim <path> [--reason R] [--ttl 4h] [--session S] | dia claims [--all] [--mine] [--gc [--days 7]] | dia unclaim <path|id> [--force]
  dia team run <id> --mock | --acp|--dsh --workspace DIR
  dia team gate|accept|reject|next
  dia team accept <id> [--note ...] [--pr N [--repo R] [--merge]]   # --pr：先验 CI，绿才接受/合并
  dia job <list|status|install|...>   # 调度适配器
  dia price list|--json
  dia postinstall [--quiet]             # 装配内置能力（npm 拦截脚本 / ignore-scripts 时的兜底；幂等）
  dia migrate data [--from DIR] [--dry-run]   # 旧数据根 → 数据根（只搬数据子目录，合并同名目录）
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
    // ── kit 聚合：已装 kit 的知识也参与检索（design: docs/kit-layer.md §3）──
    // --tag 过滤 kit（按 kit 清单 tags）；persona 自带 KB 始终参与
    const tagFilter = flag(args, "--tag");
    const rootsByPath = new Map<string, string>();
    let kitHits = 0;
    for (const k of kit.installed()) {
      if (tagFilter && !k.tags.includes(tagFilter)) continue;
      let kr: any[] = [];
      try {
        // kit 内容会随升级变化：索引不是 ok（缺失/过期/属主不符）就重建
        if ((await indexStatus(k.dir)).state !== "ok") await buildIndex(k.dir);
        kr = await search(k.dir, q, undefined, limit);
      } catch {
        try { await buildIndex(k.dir); kr = await search(k.dir, q, undefined, limit); } catch { kr = []; }
      }
      for (const h of kr) {
        rootsByPath.set(`${k.id}:${h.path}`, k.dir);
        rows.push({ ...h, path: `${k.id}:${h.path}`, source: `kit:${k.id}@${k.version}` } as any);
        kitHits++;
      }
    }
    // 合并策略：kit 命中至少保留一半名额，避免被 persona 结果按分数挤掉（否则"装了解析不到"）
    if (kitHits) {
      const kitRows = rows.filter((r: any) => r.source);
      const personaRows = rows.filter((r: any) => !r.source);
      const kitQuota = Math.min(kitRows.length, Math.max(1, Math.floor(limit / 2)));
      const picked = [...personaRows.slice(0, limit - kitQuota), ...kitRows.slice(0, kitQuota)];
      rows = picked.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
    }

    const full = sub === "query" && has(args, "--full");
    const bytes = sub === "query" && has(args, "--bytes");
    const enrich = rows.map((r: any) => {
      const item: any = { ...r };
      const rowRoot = rootsByPath.get(r.path) ?? root;
      const rowPath = r.source ? r.path.split(":").slice(1).join(":") : r.path;
      try {
        if (bytes) item.bytes = Buffer.byteLength(getDoc(rowRoot, rowPath), "utf8");
        if (full) item.text = getDoc(rowRoot, rowPath);
      } catch {
        item.stale_index = true;
        item.text = null;
        item.bytes = null;
      }
      return item;
    });
    if (has(args, "--json")) out(JSON.stringify(enrich));
    else for (const r of enrich) {
      out(`${r.source ? `[${r.source}] ` : ""}${r.path}\t${r.title}\n  ${r.snippet}`);
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
  const csv = (name: string) => (flag(args, name) || "").split(",").map((x) => x.trim()).filter(Boolean);
  try {
    if (sub === "add") {
      const title = positional(args).join(" ") || flag(args, "--title");
      if (!title) { err("missing title"); return 2; }
      const prog = flag(args, "--progress");
      const t = task.add(title, {
        role: flag(args, "--role"), judge: flag(args, "--judge"), owner: flag(args, "--owner"),
        deps: csv("--depends"), touches: csv("--touches"),
        prio: flag(args, "--prio"), start: flag(args, "--start"), due: flag(args, "--due"),
        progress: prog === undefined ? undefined : task.normProgress(prog),
      });
      out(asJson ? JSON.stringify(t) : `${t.id} ${t.title}`);
      return 0;
    }
    if (sub === "list") {
      const rows = task.list();
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((t) => `${t.id}\t${t.status}\t${t.title}${t.owner ? `\towner=${t.owner}` : ""}${t.deps.length ? `\tdeps=${t.deps.length}` : ""}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "link") {
      const id = positional(args)[0];
      if (!id) { err("usage: dia task link <id> [--depends a,b] [--remove-depends c] [--touches p1,p2] [--remove-touches p3]"); return 2; }
      const t = task.link(id, { addDeps: csv("--depends"), removeDeps: csv("--remove-depends"), addTouches: csv("--touches"), removeTouches: csv("--remove-touches") });
      out(asJson ? JSON.stringify(t) : `${t.id}\tdeps=${t.deps.join(",") || "-"}\ttouches=${t.touches.join(",") || "-"}`);
      return 0;
    }
    if (sub === "plan") {
      const id = positional(args)[0];
      if (!id) { err("usage: dia task plan <id> [--prio P1] [--start YYYY-MM-DD] [--due YYYY-MM-DD] [--progress 0-100]"); return 2; }
      const prog = flag(args, "--progress");
      const t = task.plan(id, {
        prio: flag(args, "--prio"), start: flag(args, "--start"), due: flag(args, "--due"),
        progress: prog === undefined ? undefined : task.normProgress(prog),
      });
      out(asJson ? JSON.stringify(t) : `${t.id}\tprio=${t.prio || "-"}\tstart=${t.start || "-"}\tdue=${t.due || "-"}\tprogress=${t.progress ?? "-"}`);
      return 0;
    }
    if (sub === "split") {
      const id = positional(args)[0];
      const into = flag(args, "--into");
      if (!id || !into) { err("usage: dia task split <id> --into \"切片A,切片B\" [--slice 切片A] [--force]"); return 2; }
      const parent = task.split(id, into.split(","), {
        slice: flag(args, "--slice"), role: flag(args, "--role"), judge: flag(args, "--judge"),
        touches: csv("--touches"), force: has(args, "--force"),
      });
      const kids = (parent.split_children || []).map((cid) => { const c = task.get(cid); return `${c.id}\t${c.title}${c.slice ? "\t[slice]" : ""}`; });
      out(asJson ? JSON.stringify(parent) : `${parent.id}\tchildren=${(parent.split_children || []).length}\n${kids.join("\n")}`);
      return 0;
    }
    if (sub === "status") {
      const id = positional(args)[0];
      const st = positional(args)[1] as task.Status;
      if (!id || !st) { err("usage: dia task status <id> <status> [--evidence ...] [--reason R] [--blocked-reason R]"); return 2; }
      const t = task.status(id, st, flag(args, "--evidence"), { closureReason: flag(args, "--reason"), blockedReason: flag(args, "--blocked-reason") });
      out(asJson ? JSON.stringify(t) : `${t.id} -> ${t.status}${t.closure_reason ? ` (${t.closure_reason})` : ""}`);
      return 0;
    }
    if (sub === "done") {
      const id = positional(args)[0];
      if (!id) { err("missing id"); return 2; }
      const t = task.status(id, "done", flag(args, "--evidence"), { closureReason: flag(args, "--reason") });
      out(asJson ? JSON.stringify(t) : `${t.id} -> done${t.closure_reason ? ` (${t.closure_reason})` : ""}`);
      return 0;
    }
  } catch (e: any) { err(e?.message || String(e)); return 30; }
  err("usage: dia task add|list|link|plan|split|status|done");
  return 2;
}

async function graphCli(argv: string[]): Promise<number> {
  const asJson = has(argv, "--json");
  if (has(argv, "--next") || has(argv, "--explain") || has(argv, "--lint")) {
    const tasks = task.list();
    const dr = plan.derive(tasks);
    if (has(argv, "--explain")) {
      const id = flag(argv, "--explain");
      if (!id || id.startsWith("--")) { err("usage: dia graph --explain <id>"); return 2; }
      const t = tasks.find((x) => x.id === id);
      const d = dr.byId.get(id);
      if (!t || !d) { err(`E_GRAPH: 任务不存在 ${id}`); return 2; }
      const info = {
        id, title: t.title, status: t.status, declared: t.prio ?? null, eff: d.eff_prio,
        inherited: d.prio_inherited, source: d.prio_source ?? null,
        ready: d.ready, startable: d.startable, rank: d.rank,
        blocked_by: d.blocked_by, released_by: d.released_by, dangling: d.dangling_deps,
        unblocks: d.unblocks, critical: d.critical, slice: !!t.slice,
      };
      out(asJson ? JSON.stringify(info) : [
        `${id}  ${t.title}`,
        `status=${t.status}  declared=${info.declared ?? "-"}  eff=${info.eff}${d.prio_inherited ? ` (继承自 ${d.prio_source?.id} ${d.prio_source?.declared}, ${d.prio_source?.distance} 跳)` : ""}`,
        `ready=${d.ready}  startable=${d.startable}  rank=${d.rank ?? "-"}  unblocks=${d.unblocks}  critical=${d.critical}`,
        `blocked_by=${d.blocked_by.join(",") || "-"}  released_by=${d.released_by.join(",") || "-"}  dangling=${d.dangling_deps.join(",") || "-"}`,
      ].join("\n"));
      return 0;
    }
    if (has(argv, "--lint")) {
      const findings = dr.lint;
      out(asJson ? JSON.stringify({ findings, cycles: dr.cycles }) : (findings.length ? findings.map((f) => `${f.kind}\t${f.id}\t${f.detail}`).join("\n") : "(clean)"));
      return dr.cycles.length ? 3 : 0;
    }
    if (has(argv, "--seats")) {
      const nRaw = flag(argv, "--seats");
      const n = Number(nRaw);
      if (!Number.isInteger(n) || n < 0) { err("E_USAGE: --seats 必须是 >=0 的整数"); return 2; }
      const ttlRaw = flag(argv, "--presence-ttl");
      let ttlMs: number | undefined;
      if (ttlRaw) {
        const m = /^(\d+)([mhd])$/.exec(ttlRaw.trim());
        if (!m) { err("E_USAGE: --presence-ttl 形如 30m / 4h"); return 2; }
        ttlMs = Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]);
      }
      const nowRaw = flag(argv, "--now");
      const now = nowRaw ? new Date(nowRaw) : undefined;
      if (now && Number.isNaN(now.getTime())) { err("E_USAGE: 非法 --now"); return 2; }
      // 任一 dia 命令都刷新 presence：先把发起会话登记为在线（无会话标识时跳过）
      try { collab.whoami({ session }); } catch { /* no session */ }
      const res = seats.assignSeats(tasks, { seats: n, now, presenceTtlMs: ttlMs });
      if (asJson) out(JSON.stringify(res, null, 1));
      else {
        if (!res.seats.length) out("(没有在线席位；先跑 dia whoami 注册会话)");
        else for (const s of res.seats) out(`seat ${s.seat}\t${s.state}\t${s.focus || "-"}\tpresence=${s.presence_at}`);
        for (const a of res.assignments) out(`  → ${a.seat}\t${a.task}\trank=${a.rank}\t${a.eff}\tcost=${a.cost}\t${a.why}`);
        for (const u of res.unassigned) out(`  · 未分配 ${u.task}\trank=${u.rank}\t${u.reason}`);
        for (const c of res.conflicts) out(`  ⚠ ${c.kind}\t${c.task}\t${c.detail}`);
        out(`metrics: assignments=${res.metrics.assignments} idle=${res.metrics.idle_slots} online=${res.metrics.online}`);
      }
      return dr.cycles.length ? 3 : 0;
    }
    // --next [n]
    const raw = flag(argv, "--next");
    const n = raw && /^\d+$/.test(raw) ? Math.max(1, Number(raw)) : 5;
    const doing = tasks.filter((t) => t.status === "doing" && dr.byId.get(t.id)!.rank !== null)
      .sort((a, b) => (dr.byId.get(a.id)!.rank! - dr.byId.get(b.id)!.rank!));
    const startable = tasks.filter((t) => dr.byId.get(t.id)!.startable)
      .sort((a, b) => (dr.byId.get(a.id)!.rank! - dr.byId.get(b.id)!.rank!));
    const picked = [...doing, ...startable].slice(0, n);
    const items = picked.map((t) => {
      const d = dr.byId.get(t.id)!;
      return {
        id: t.id, title: t.title, status: t.status, rank: d.rank,
        declared: t.prio ?? null, eff: d.eff_prio, inherited: d.prio_inherited,
        ready: d.ready, critical: d.critical, unblocks: d.unblocks,
        blocked_by: d.blocked_by,
        why: `${t.status === "doing" ? "进行中" : "可开工"} · eff=${d.eff_prio}${d.prio_inherited ? `(←${d.prio_source?.id})` : ""} · 解锁${d.unblocks}${d.critical ? " · 关键路径" : ""}`,
      };
    });
    out(asJson ? JSON.stringify({ policy: dr.ranking.policy, items })
      : (items.length ? items.map((x, i) => `#${i + 1}\t${x.id}\t${x.eff}${x.inherited ? "(继承)" : ""}\t${x.title}\t${x.why}`).join("\n") : "(没有可开工任务)"));
    return dr.cycles.length ? 3 : 0;
  }
  if (has(argv, "--export-html") || has(argv, "--out")) {
    const nowRaw = flag(argv, "--now");
    const now = nowRaw ? new Date(nowRaw) : new Date();
    if (Number.isNaN(now.getTime())) { err(`E_GRAPH: --now 不是合法时间（收到 ${nowRaw}）`); return 2; }
    const limitRaw = flag(argv, "--limit");
    const limit = has(argv, "--all") ? 0 : (limitRaw === undefined ? 500 : Number(limitRaw));
    if (!Number.isInteger(limit) || limit < 0) { err("E_GRAPH: --limit 必须是 >=0 的整数"); return 2; }
    const stamp = `${graphHtml.localDay(now).replace(/-/g, "")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const argPath = flag(argv, "--export-html");
    const positionalOut = argPath && !argPath.startsWith("-") ? argPath : "";
    const outPath = flag(argv, "--out") || positionalOut || join(paths.diaHome(), "export", `graph-${stamp}.html`);
    if (existsSync(outPath) && !has(argv, "--force")) { err(`E_GRAPH: 已存在 ${outPath}（用 --force 覆盖）`); return 2; }
    try {
      const g = graph.build({ task: flag(argv, "--task") });
      const html = graphHtml.renderHtml(g, { now, redact: has(argv, "--redact"), limit, claims: claims.list().length });
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, html, { mode: 0o600 });
      out(outPath);
      return 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return String(e?.message || e).startsWith("E_GRAPH") ? 2 : 31;
    }
  }
  if (has(argv, "--tui") || has(argv, "--watch")) {
    const width = Number(flag(argv, "--width") || 0);
    const tuiOpts = {
      color: !!process.stdout.isTTY && !has(argv, "--no-color"),
      status: flag(argv, "--status"),
      owner: flag(argv, "--owner"),
      width: width > 0 ? width : undefined,
    };
    const paint = (g: any) => out(graphTui.render(g, tuiOpts));
    try {
      if (has(argv, "--watch")) return await graphTui.watch(() => graph.build({ task: flag(argv, "--task") }), tuiOpts);
      const g = graph.build({ task: flag(argv, "--task") });
      paint(g);
      return g.cycles.length ? 3 : 0;
    } catch (e: any) {
      err(e?.message || String(e));
      return String(e?.message || e).startsWith("E_GRAPH") ? 2 : 31;
    }
  }
  try {
    const g = graph.build({ task: flag(argv, "--task") });
    if (asJson) out(JSON.stringify(g, null, 1));
    else {
      for (const n of g.nodes.filter((x) => x.kind === "task")) {
        out(`${n.label}\t[${n.status || "?"}]${n.owner ? `\towner=${n.owner}` : ""}`);
        for (const e of g.edges.filter((x) => x.from === n.id && x.kind === "depends_on")) out(`  -> ${e.to.replace(/^task:/, "")}`);
      }
      const claimEdges = g.edges.filter((e) => e.kind === "claims");
      if (claimEdges.length) {
        out("claims:");
        for (const e of claimEdges) out(`  ${e.from.replace(/^session:/, "")} -> ${e.to.replace(/^path:/, "")}`);
      }
      for (const c of g.cycles) out(`⚠ cycle: ${c.join(" -> ")}`);
    }
    return g.cycles.length ? 3 : 0;
  } catch (e: any) {
    err(e?.message || String(e));
    return String(e?.message || e).startsWith("E_GRAPH") ? 2 : 31;
  }
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
  const looksSession = (s?: string) => !!s && /^ses_[A-Za-z0-9]+$/.test(s);
  // v2 兼容入口：显式 --to / 位置参数是 session id 时走会话级 collab；旧 agent 名路径保持原样。
  if (sub === "send") {
    const toFlag = flag(args, "--to");
    const pos = positional(args)[0];
    const to = toFlag || (looksSession(pos) ? pos : undefined);
    if (to) {
      const rest = toFlag ? [...args] : args.filter((a, i) => !(a === pos && i === args.indexOf(pos)));
      return collabCli(["out", "--to", to, ...rest]);
    }
  }
  if (sub === "inbox" && flag(args, "--session")) return collabCli(["in", ...args]);
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
    if (sub === "migrate") {
      const r = collab.migrateLegacy({ dryRun: has(args, "--dry-run") });
      if (asJson) out(JSON.stringify(r, null, 1));
      else out(`${has(args, "--dry-run") ? "dry-run" : "migrated"}: total=${r.total} migrated=${r.migrated} skipped=${r.skipped}`);
      return 0;
    }
  } catch (e: any) {
    const m = e?.message || String(e);
    err(m);
    if (m.startsWith("E_NOT_FOUND")) return 21;
    if (m.startsWith("E_STATE") || m.startsWith("E_HOPS") || m.startsWith("E_RECIPIENT")) return 22;
    if (m.startsWith("E_USAGE") || m.startsWith("E_SESSION") || m.startsWith("E_NO_SESSION") || m.startsWith("E_LEGACY") || m.startsWith("E_KIND")) return 2;
    return 31;
  }
  err("usage: dia msg send|inbox|ack|delivered|reply|thread|escalate|agents");
  return 2;
}

async function claimsCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  const session = flag(args, "--session");
  try {
    if (sub === "claim") {
      const path = positional(args)[0];
      if (!path) { err("usage: dia claim <path> [--reason R] [--ttl 4h] [--session S] [--json]"); return 2; }
      const r = claims.claim(path, { reason: flag(args, "--reason"), ttl: flag(args, "--ttl"), session });
      if (asJson) out(JSON.stringify(r, null, 1));
      else {
        out(`claimed ${r.claim.id}  ${r.claim.scope}:${r.claim.path}  holder=${r.claim.holder}  expires=${r.claim.expires_at}`);
        for (const o of r.overlaps) out(`  ⚠ overlap: ${o.holder} (${o.reason || "no reason"}) expires=${o.expires_at}`);
      }
      return 0;
    }
    if (sub === "claims") {
      if (has(args, "--gc")) {
        const r = claims.compact({ days: Number(flag(args, "--days") || 7) });
        out(asJson ? JSON.stringify(r, null, 1) : `claims gc: before=${r.before} after=${r.after} dropped=${r.dropped}`);
        return 0;
      }
      const mine = has(args, "--mine") ? collab.resolveSessionId(session) : undefined;
      const rows = claims.list({ all: has(args, "--all"), mine });
      out(asJson ? JSON.stringify(rows, null, 1)
        : rows.map((c) => `${c.path}\t${c.holder}\t${c.reason || ""}\t${c.expires_at}${claims.isActive(c) ? "" : "\t(expired)"}`).join("\n") || "(none)");
      return 0;
    }
    if (sub === "unclaim") {
      const target = positional(args)[0];
      if (!target) { err("usage: dia unclaim <path|id> [--force] [--session S]"); return 2; }
      const c = claims.unclaim(target, { session, force: has(args, "--force") });
      out(asJson ? JSON.stringify(c, null, 1) : `released ${c.id}  ${c.scope}:${c.path}`);
      return 0;
    }
  } catch (e: any) {
    const m = e?.message || String(e);
    err(m);
    if (m.startsWith("E_NO_SESSION") || m.startsWith("E_USAGE") || m.startsWith("E_CLAIM_PATH")) return 2;
    if (m.startsWith("E_CLAIM_OWNER")) return 22;
    if (m.startsWith("E_CLAIM:")) return 21;
    return 31;
  }
  err("usage: dia claim|claims|unclaim ...");
  return 2;
}

/** 数据根迁移（取代 install.sh --migrate）：只搬数据子目录，合并同名目录，失败计数退 1。 */
function migrateCli(argv: string[]): number {
  const sub = positional(argv)[0];
  if (sub !== "data") { err("usage: dia migrate data [--from DIR] [--dry-run]"); return 2; }
  const from = flag(argv, "--from") || join(homedir(), ".local", "share", "dia");
  const to = paths.diaHome();
  const dry = has(argv, "--dry-run");
  const subs = ["personas", "msg", "agents", "state", "cache", "job", "runs", "audit", "tasks", "ingest", "runtime", "eval", "backups"];
  if (!existsSync(from)) { out(`无需迁移：${from} 不存在`); return 0; }
  let moved = 0, failed = 0;
  for (const d of subs) {
    const src = join(from, d);
    if (!existsSync(src)) continue;
    const dest = join(to, d);
    if (existsSync(dest)) {
      if (dry) { out(`[dry-run] merge ${src} → ${dest}`); moved++; continue; }
      try { cpSync(src, dest, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); moved++; }
      catch (e: any) { failed++; err(`! 合并失败 ${src} → ${dest}：${e?.message || e}`); }
    } else {
      if (dry) { out(`[dry-run] mv ${src} → ${dest}`); moved++; continue; }
      try { mkdirSync(to, { recursive: true }); renameSync(src, dest); moved++; }
      catch (e: any) { failed++; err(`! 迁移失败 ${src}：${e?.message || e}`); }
    }
  }
  out(`migrate data：处理 ${moved} 个子目录，失败 ${failed}（${from} → ${to}）`);
  return failed ? 1 : 0;
}

async function collabCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  const session = flag(args, "--session");
  const refs: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref" && args[i + 1]) {
      const [k, ...v] = args[i + 1].split("=");
      if (k && v.length) refs[k] = v.join("=");
      i++;
    }
  }
  const touchPaths = [...flags(args, "--touch"), ...(flag(args, "--touches") || "").split(",")]
    .map((x) => x.trim()).filter(Boolean);
  if (touchPaths.length) refs.touches = touchPaths.join(",");
  const refPaths = (m: collab.MessageV2) => [
    ...(m.refs?.touches || "").split(","),
    ...(m.refs?.path ? [m.refs.path] : []),
  ].map((x) => x.trim()).filter(Boolean);
  const view = (m: collab.MessageV2) => ({ ...m, class: m.class_snapshot !== undefined ? msgPriority.className(m.class_snapshot) : undefined, body: collab.bodyOf(m) });
  const print = (m: collab.MessageV2) => {
    out(`${m.id}\t[${m.state}]${m.class_snapshot !== undefined ? `[${msgPriority.className(m.class_snapshot)}]` : ""}\t${m.subject}`);
    out(`  from: ${m.from.display_name || m.from.session_id} (${m.from.session_id})`);
    out(`  to:   ${m.to.display_name || m.to.session_id} (${m.to.session_id})`);
    out(`  kind: ${m.kind}${m.requires_reply ? "  需回复" : ""}${m.deadline ? `  deadline=${m.deadline}` : ""}  thread=${m.thread_id}#${m.seq}`);
    if (m.refs && Object.keys(m.refs).length) out(`  refs: ${Object.entries(m.refs).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    const touches = refPaths(m);
    if (touches.length) {
      const held = claims.list({}).filter((c) => touches.includes(c.path) && c.holder !== m.to.session_id);
      for (const c of held) out(`  ⚠ claim: ${c.path} 由 ${c.holder} 持有（${c.reason || "no reason"}）`);
    }
    const body = collab.bodyOf(m);
    if (body) {
      const max = 4000;
      const shown = body.length > max ? `${body.slice(0, max)}\n  …（正文 ${body.length} 字符，完整看 dia show ${m.id}）` : body;
      out(shown.split("\n").map((l) => `  ${l}`).join("\n"));
    } else if (m.body_ref) {
      out("  ⚠️ 正文文件缺失（bodies/ 下找不到）");
    }
    if (m.body_missing) out("  ⚠️ 旧消息正文缺失（迁移时源文件已不存在）");
    if (m.legacy) out("  （旧消息只读，不能 ack/reply/close）");
    else out(`  处理: dia ack ${m.id} | dia reply ${m.id} --body "..." | dia close ${m.id} --reason done`);
    out("");
  };
  try {
    const personaId = flag(args, "--persona") || process.env.DIA_PERSONA || undefined;
    if (sub === "status") {
      const s = defaultMsg.status(personaId);
      if (asJson) out(JSON.stringify(s, null, 1));
      else {
        out(`enabled: ${s.enabled}${s.reason ? `  (${s.reason})` : ""}`);
        out(`kit: ${s.kit_installed || "(not installed)"}  source=${s.kit_dir}`);
        out(`config: ${s.config_file}`);
        if (s.disabled_personas.length) out(`disabled personas: ${s.disabled_personas.join(", ")}`);
      }
      return 0;
    }
    if (sub === "enable" || sub === "disable") {
      const c = defaultMsg.setEnabled(sub === "enable", personaId);
      let removed: string[] = [];
      if (sub === "disable" && !personaId) {
        try { removed = kit.remove("dia-msg").removed; }
        catch (e: any) {
          if (!String(e?.message || e).startsWith("E_NOT_INSTALLED")) err(`warn: 移除 dia-msg kit 失败：${e?.message || e}`);
        }
      }
      const kitInfo = sub === "enable" ? defaultMsg.ensure(personaId, { force: true }) : null;
      const jobWarn = sub === "enable" ? observer.ensureJob() : null;
      out(asJson ? JSON.stringify({ ...c, removed, kit: kitInfo }, null, 1)
        : `${sub}d: enabled=${c.enabled}${c.disabled_personas.length ? ` disabled_personas=${c.disabled_personas.join(",")}` : ""}` +
          (removed.length ? `  removed=${removed.length}` : "") +
          (kitInfo ? (kitInfo.ok ? `  kit=${kitInfo.kit}` : `  ⚠ ${kitInfo.reason}`) : "") +
          (jobWarn ? `  ⚠ 观察器定时未注册：${jobWarn}（手动：dia job install collab-observe --interval 300 --cmd 'dia collab observe'）` : ""));
      // enable 装不上内置 kit 时必须非 0：否则 CI/脚本无法判断「消息能力是否真的可用」
      if (kitInfo && !kitInfo.ok) return 32;
      return 0;
    }
    if (sub === "board" || sub === "observe") {
      const allowed = sub === "observe"
        ? ["--once", "--interval", "--now", "--json"]
        : ["--cached", "--refresh", "--now", "--json"];
      const daemonFlags = ["--watch", "--daemon", "--follow"];
      for (const a of args) {
        if (!a.startsWith("--")) continue;
        if (daemonFlags.includes(a)) { err("E_NO_DAEMON: dia 无常驻设计；定时请用 dia job install（observe 恒为一次性）"); return 2; }
        if (!allowed.includes(a)) { err(`E_USAGE: 未知参数 ${a}（允许：${allowed.join(" ")}）`); return 2; }
      }
      const nowRaw = flag(args, "--now");
      const now = nowRaw ? new Date(nowRaw) : undefined;
      if (now && Number.isNaN(now.getTime())) { err("E_USAGE: 非法 --now"); return 2; }

      const outBoard = (b: any, meta?: any) => {
        const payload = meta ? { ...b, ...meta } : b;
        if (asJson) { out(JSON.stringify(payload, null, 1)); return; }
        const f = (v: number | null | undefined) => v === null || v === undefined ? "-" : String(v);
        const tag = meta?.missing ? "  missing" : meta?.stale ? `  快照 ${Math.round((meta.age_ms || 0) / 60000)} 分钟前（可能过期）` : "";
        out(`board ${b?.generated_at || "-"}  open=${b?.open ?? 0}  P0=${b?.p0 ?? 0}  P1=${b?.p1 ?? 0}  undelivered=${b?.undelivered ?? 0}  oldest=${b?.oldest_age_ms ?? 0}ms${tag}`);
        if (b?.top?.length) { out("top:"); for (const t of b.top) out(`  P${t.class}\t${t.id}\t${t.subject}\t${t.age_ms}ms`); }
        if (b?.escalations) out(`escalations: ${b.escalations}（详见 ~/.dia/collab/escalations.jsonl）`);
      };

      if (sub === "observe") {
        const intervalSec = flag(args, "--interval") === undefined ? undefined : Number(flag(args, "--interval"));
        if (intervalSec !== undefined && (!Number.isInteger(intervalSec) || intervalSec < observer.MIN_INTERVAL_S || intervalSec > observer.MAX_INTERVAL_S)) {
          err(`E_USAGE: --interval 必须是 ${observer.MIN_INTERVAL_S}-${observer.MAX_INTERVAL_S} 的整数秒`); return 2;
        }
        outBoard(observer.observe({ now, intervalSec }));
        return 0;
      }

      if (has(args, "--refresh")) { outBoard(observer.observe({ now })); return 0; }
      const st = observer.readBoardState({ now });
      if (has(args, "--cached") && st.missing) {
        if (asJson) out(JSON.stringify({ board: null, missing: true, stale: true }, null, 1));
        else out("(no board cache；先跑 dia collab observe)");
        return 3;
      }
      outBoard(st.board, { stale: st.stale, age_ms: st.age_ms, missing: st.missing, persisted: st.persisted });
      return 0;
    }
    if (sub === "stats") {
      const nowRaw = flag(args, "--now");
      const now = nowRaw ? new Date(nowRaw) : undefined;
      if (now && Number.isNaN(now.getTime())) { err("E_USAGE: 非法 --now"); return 2; }
      const by = flag(args, "--by") as "session" | "pair" | "class" | undefined;
      if (by && !["session", "pair", "class"].includes(by)) { err("E_USAGE: --by 必须是 session|pair|class"); return 2; }
      const st = collab.messageStats({ since: flag(args, "--since"), by, now });
      if (asJson) { out(JSON.stringify(st, null, 1)); return 0; }
      const f = (v: number | null | undefined) => v === null || v === undefined ? "-" : String(v);
      out(`cohort ${st.since} → ${st.as_of}  total=${st.cohort.total}`);
      out(`  delivered=${f(st.cohort.delivered_rate)}  exposed=${f(st.cohort.exposed_rate)}  ack=${f(st.cohort.ack_rate)}  reply=${f(st.cohort.reply_rate)}`);
      out(`  deliver_lag median=${f(st.cohort.deliver_lag_ms.median)}ms p90=${f(st.cohort.deliver_lag_ms.p90)}ms  (n=${st.cohort.deliver_lag_ms.n})`);
      out(`  reply_latency median=${f(st.cohort.reply_latency_ms.median)}ms p90=${f(st.cohort.reply_latency_ms.p90)}ms  (n=${st.cohort.reply_latency_ms.n}, censored=${st.cohort.reply_latency_ms.censored})`);
      out(`backlog count=${st.backlog.count} oldest=${st.backlog.oldest_age_ms}ms orphan=${st.backlog.orphan}`);
      if (st.groups.length) { out("by " + (by || "session") + ":"); for (const g of st.groups) out(`  ${g.key}\ttotal=${g.total}\treplied=${g.replied}\treply_median=${f(g.reply_latency_ms)}ms`); }
      return 0;
    }
    if (sub === "whoami") {
      const rec = collab.whoami({ session, name: flag(args, "--name") });
      out(asJson ? JSON.stringify(rec, null, 1) : `${rec.session_id}\t${rec.display_name}\t${rec.host}\t${rec.cwd}`);
      return 0;
    }
    if (sub === "in") {
      if (has(args, "--legacy")) {
        const rows = collab.legacyInbox({ limit: Number(flag(args, "--limit") || 0) });
        out(asJson ? JSON.stringify(rows.map(view), null, 1) : rows.map((m) => `${m.id}\t${m.state}\t${m.subject}`).join("\n") || "(empty)");
        if (!asJson) rows.forEach(print);
        return 0;
      }
      const sid = collab.resolveSessionId(session);
      collab.whoami({ session: sid });
      const classes = (flag(args, "--class") || "").split(",").map((x) => x.trim().toUpperCase()).map((x) => {
        const m = /^P([0-3])$/.exec(x); return m ? Number(m[1]) : null;
      }).filter((n): n is number => n !== null);
      const opts = {
        unread: has(args, "--unread"), all: has(args, "--all"), limit: Number(flag(args, "--limit") || 0),
        sort: (flag(args, "--sort") === "arrival" ? "arrival" : "priority") as "arrival" | "priority",
        classes: classes.length ? classes : undefined,
      };
      const before = collab.inbox(sid, opts);
      const willMark = !has(args, "--no-mark");
      const stamp = new Date().toISOString();
      // 展示层先反映「即将送达」，真正落盘在 print 成功之后（EPIPE/截断不算送达）
      const shown = willMark
        ? before.map((m) => (m.state === "pending" && !m.delivered_at ? { ...m, state: "delivered" as const, delivered_at: stamp } : m))
        : before;
      if (asJson) out(JSON.stringify(shown.map(view), null, 1));
      else if (!shown.length) out("(empty)");
      else shown.forEach(print);
      if (willMark) {
        const pending = before.filter((m) => !m.delivered_at && m.state === "pending").map((m) => m.id);
        if (pending.length) collab.markDeliveredBatch(sid, pending);
      }
      if (has(args, "--expose") && before.length) collab.markExposed(sid, before.map((m) => m.id));
      return 0;
    }
    if (sub === "out") {
      const to = flag(args, "--to");
      if (!to) { err("usage: dia out --to <session_id> --subject S (--body B|--body-file F) [--kind K]"); return 2; }
      const kind = (flag(args, "--kind") || "notify") as collab.Kind;
      const requiresReply = has(args, "--requires-reply") ? true : undefined;
      const senderId = collab.resolveSessionId(session);
      const baseInfo = (() => {
        try {
          const tasks = task.list();
          const dr = plan.derive(tasks);
          const mine = tasks.filter((t) => t.owner === senderId && t.status === "doing");
          if (!mine.length) return { base: 2, why: "无 doing 任务" };
          const best = mine.map((t) => dr.byId.get(t.id)?.eff_prio ?? "P99")
            .sort((a, b) => plan.prioIndex(a) - plan.prioIndex(b))[0];
          return { base: Math.min(3, plan.prioIndex(best)), why: `doing eff=${best}` };
        } catch { return { base: 2, why: "任务账本不可读" }; }
      })();
      const cls = msgPriority.classify({
        base: baseInfo.base, kind,
        requiresReply: requiresReply ?? kind === "question",
        hops: flag(args, "--hops") ? Number(flag(args, "--hops")) : 0,
        deadline: flag(args, "--deadline"),
      });
      const m = collab.send({
        from: senderId,
        to,
        kind,
        classSnapshot: cls.cls,
        classWhy: [...cls.why, baseInfo.why],
        subject: flag(args, "--subject") || "",
        body: flag(args, "--body"),
        bodyFile: flag(args, "--body-file"),
        refs: Object.keys(refs).length ? refs : undefined,
        requiresReply,
        deadline: flag(args, "--deadline"),
        threadId: flag(args, "--thread"),
        replyTo: flag(args, "--reply-to"),
        idempotencyKey: flag(args, "--idempotency-key"),
        hops: flag(args, "--hops") ? Number(flag(args, "--hops")) : undefined,
      });
      if (m.reply_to) { try { collab.markReplied(m.reply_to, m.id); } catch { /* 原消息可能已关闭/迁移 */ } }
      const overlaps = claims.list({}).filter((c) => touchPaths.includes(c.path) && c.holder !== m.from.session_id);
      if (asJson) out(JSON.stringify(overlaps.length ? { ...m, claim_overlaps: overlaps } : m, null, 1));
      else {
        out(`${m.id}\t${m.thread_id}#${m.seq}\t${m.from.session_id} → ${m.to.session_id}\t${m.kind}\t${m.subject}`);
        for (const c of overlaps) out(`  ⚠ claim overlap: ${c.path} 由 ${c.holder} 持有（${c.reason || "no reason"}）`);
      }
      return 0;
    }
    if (sub === "ack") {
      const id = positional(args)[0];
      if (!id) { err("usage: dia ack <id> [--session S]"); return 2; }
      const m = collab.ack(collab.resolveSessionId(session), id);
      out(asJson ? JSON.stringify(m) : `${m.id}\t${m.state}`);
      return 0;
    }
    if (sub === "reply") {
      const id = positional(args)[0];
      const body = flag(args, "--body") ?? (flag(args, "--body-file") ? readFileSync(flag(args, "--body-file")!, "utf8") : undefined);
      if (!id || body === undefined) { err("usage: dia reply <id> --body B|--body-file F [--session S]"); return 2; }
      const r = collab.reply(collab.resolveSessionId(session), id, body, Object.keys(refs).length ? refs : undefined);
      out(asJson ? JSON.stringify(r) : `${r.reply.id}\t${r.reply.thread_id}#${r.reply.seq}\t${r.reply.from.session_id} → ${r.reply.to.session_id}`);
      return 0;
    }
    if (sub === "close") {
      const id = positional(args)[0];
      const reason = flag(args, "--reason");
      if (!id || !reason) { err("usage: dia close <id> --reason done|dropped|duplicate|escalated|no-follow-on [--session S]"); return 2; }
      const m = collab.close(collab.resolveSessionId(session), id, reason);
      out(asJson ? JSON.stringify(m) : `${m.id}\t${m.state}\t${m.closure_reason}`);
      return 0;
    }
    if (sub === "show") {
      const id = positional(args)[0];
      if (!id) { err("usage: dia show <id> [--json]"); return 2; }
      const m = collab.show(id);
      if (asJson) out(JSON.stringify(view(m), null, 1));
      else print(m);
      return 0;
    }
  } catch (e: any) {
    const m = e?.message || String(e);
    err(m);
    if (m.startsWith("E_NOT_FOUND")) return 21;
    if (m.startsWith("E_STATE") || m.startsWith("E_HOPS") || m.startsWith("E_RECIPIENT")) return 22;
    if (m.startsWith("E_USAGE") || m.startsWith("E_SESSION") || m.startsWith("E_NO_SESSION") || m.startsWith("E_LEGACY") || m.startsWith("E_KIND")) return 2;
    return 31;
  }
  err("usage: dia collab status|enable|disable [--persona ID] | dia whoami | dia in [--unread] [--legacy] | dia out --to S … | dia ack|reply|close|show <id>");
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
        (r.overwrites?.length ? `\n  ⚠ 覆盖 ${r.overwrites.length} 个已存在产物（已备份）：${r.overwrites.join(", ")}` : "") +
        (r.msgKit && !r.msgKit.ok ? `\n  ⚠ dia-msg 未启用：${r.msgKit.reason}` : ""));
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
      const r = persona.update(id, { ref: flag(args, "--ref"), force: has(args, "--force") });
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
    if (!id) { err("usage: dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--no-msg] [--dry-run] [--json]"); return 2; }
    try {
      const host = flag(args, "--host");
      const r = persona.create(id, { dir: flag(args, "--dir"), hosts: host ? [host] : undefined, dryRun: has(args, "--dry-run"), msg: !has(args, "--no-msg") });
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
      else out(`rendered ${r.id}@${r.version}${r.drift.length ? `（修复 ${r.drift.length} 处，备份 ${r.backups.length}）` : "（无变化）"}` +
        (r.msgKit && !r.msgKit.ok ? `\n  ⚠ dia-msg 未启用：${r.msgKit.reason}` : ""));
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
      out(asJson ? JSON.stringify(rows, null, 1) : rows.map((r: any) => `${r.id}: ${r.versions.join(", ")}${r.tags?.length ? ` [${r.tags.join(", ")}]` : ""}`).join("\n") || "(none)");
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
  if (!bin) { err("E_WT: dia-wt 未安装（npm 包不完整？`npm i -g @minonl/dia@latest` 重装；或设 DIA_WT_BIN）"); return 33; }
  const r = spawnSync("bash", [bin, ...argv], { stdio: "inherit", env: process.env });
  return r.status ?? 1;
}

/** `dia service add|remove|list|show|verify|health`（设计见 docs/service-noun.md §5）。 */
async function serviceCli(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const asJson = has(args, "--json");
  const pos = positional(args);
  try {
    if (sub === "add") {
      const from = flag(args, "--from") || pos[0];
      const dir = flag(args, "--dir") || (from ? service.serviceDir((() => {
        try { return service.readServiceManifest(from).id; } catch { return basename(from); }
      })()) : undefined);
      if (!dir) { err("usage: dia service add (<--from SRC> | --dir DIR) [--ref REF] [--dry-run] [--json]"); return 2; }
      const r = service.add({ dir, from, ref: flag(args, "--ref"), dryRun: has(args, "--dry-run") });
      if (asJson) out(JSON.stringify(r, null, 1));
      else {
        out(`${r.dryRun ? "would install" : "installed"} service ${r.id}@${r.version} -> ${r.dir}`);
        out(`  gen: ${r.gen}`);
        out(`  entry: ${r.entry.path}${r.entry.link ? ` （稳定入口 ${r.entry.link}）` : ""}`);
        out(`  jobs: ${[r.jobs.service, r.jobs.health].filter(Boolean).join(", ")}（backend: ${r.backend}）`);
        if (r.target_mismatch) out(`  ! lifecycle.target 不是本机：按归属声明应在别的机器上运行（dia 只提示）`);
        if (r.backend === "systemd") out(`  · 常驻服务需 loginctl enable-linger ${process.env.USER || "$USER"}（否则注销后停止）`);
      }
      return 0;
    }
    if (sub === "remove") {
      const id = pos[0];
      if (!id) { err("usage: dia service remove <id>"); return 2; }
      const r = service.remove({ id });
      out(asJson ? JSON.stringify(r, null, 1) : `removed service ${id}` +
        (r.removed.length ? `\n  ${r.removed.join("\n  ")}` : "") + (r.skipped.length ? `\n  skipped: ${r.skipped.join(", ")}` : ""));
      return 0;
    }
    if (sub === "list" || sub === undefined) {
      const rows = service.listServices();
      if (asJson) { out(JSON.stringify(rows, null, 1)); return 0; }
      if (!rows.length) { out("(no services)"); return 0; }
      for (const r of rows) {
        out(`${r.id}@${r.version ?? "-"}  health=${r.label}${r.problem ? `  ! ${r.problem}` : ""}`);
        if (r.lifecycle) out(`  lifecycle: ${r.lifecycle.type}${r.lifecycle.interval ? ` ${r.lifecycle.interval}s` : ""}${r.target ? ` target=${r.target}${r.on_this_host ? "" : "（非本机）"}` : ""}`);
      }
      return 0;
    }
    if (sub === "show") {
      const id = pos[0];
      if (!id) { err("usage: dia service show <id>"); return 2; }
      const r = service.showService(id);
      if (!r) { err(`E_NOT_INSTALLED: service ${id}`); return 2; }
      if (asJson) { out(JSON.stringify(r, null, 1)); return 0; }
      out(`${r.id}@${r.version ?? "-"}  dir=${r.dir}`);
      out(`  health: ${r.label}${r.last_error ? `  (last_error: ${r.last_error})` : ""}`);
      out(`  gen: ${r.gen ?? "-"}  adopted: ${r.adopted}`);
      if (r.lock) out(`  entry: ${r.lock.entry.path}${r.lock.entry.link ? ` （稳定入口 ${r.lock.entry.link}）` : ""}`);
      out(`  jobs: ${[r.jobs.service, r.jobs.health].filter(Boolean).join(", ")}`);
      if (r.last) out(`  last: ts=${r.last.ts} state=${r.last.state} candidate=${r.last.candidate}/${r.last.streak} source=${r.last.source}`);
      if (r.problem) out(`  ! ${r.problem}`);
      return 0;
    }
    if (sub === "verify") {
      const id = pos[0];
      const dir = flag(args, "--dir") || (id ? service.serviceDir(id) : undefined);
      if (!dir) { err("usage: dia service verify <id|--dir DIR>"); return 2; }
      const r = service.verify(dir);
      out(asJson ? JSON.stringify(r, null, 1) : `${r.ok ? "ok" : "DRIFT"} ${r.id}（entry: ${r.entry.kind} ${r.entry.path}）` +
        (r.drift.length ? `\n  ${r.drift.map((d) => `${d.code}: ${d.detail}`).join("\n  ")}` : ""));
      return r.ok ? 0 : 1;
    }
    if (sub === "health") {
      // --exit N 是 flag（不是位置参数）：目标 id 取剩余位置参数的第一个
      const id = (() => {
        const f = new Set(["--exit", "--gen", "--state-file", "--json"]);
        for (let i = 0; i < args.length; i++) {
          if (args[i].startsWith("--")) { if (!args[i].includes("=") && f.has(args[i])) i++; continue; }
          return args[i];
        }
        return undefined;
      })();
      if (!id) { err("usage: dia service health <id>"); return 2; }
      const fromWrapper = has(args, "--from-wrapper");
      const ex = flag(args, "--exit");
      // agent 型（§14.3）：健康由 dia 自己发起 ACP initialize + session/new，没有外部 cmd 可跑
      const dir = service.serviceDir(id);
      const svc = service.readServiceManifest(dir);
      if (service.healthcheckKind(svc.healthcheck) === "acp" && !fromWrapper) {
        const run = await service.runAcpHealth(svc, { dir });
        const rec = service.recordHealth(svc, run.judgement, { gen: flag(args, "--gen"), stateFile: flag(args, "--state-file") });
        const code = run.judgement.state === "ok" ? 0 : run.judgement.state === "degraded" ? 30 : 1;
        if (asJson) out(JSON.stringify({ id, verdict: run.judgement.state, shown: rec.record.state, exit: run.judgement.exit, detail: run.judgement.detail, steps: run.steps }, null, 1));
        else out(`${id}: ${run.judgement.state}（shown=${rec.record.state}${run.judgement.detail ? ", " + run.judgement.detail : ""}）`);
        return code;
      }
      const r = service.runServiceHealth(id, {
        wrapperExit: fromWrapper ? Number(ex ?? "1") : undefined,
        gen: flag(args, "--gen"),
        stateFile: flag(args, "--state-file"),
      });
      if (asJson) out(JSON.stringify(r.json, null, 1));
      else out(`${r.id}: ${r.json.verdict}（shown=${r.record.state}${r.judgement.timeout ? ", timeout" : ""}${r.judgement.detail ? ", " + r.judgement.detail : ""}）`);
      return r.exit;
    }
  } catch (e: any) {
    const m = e?.message || String(e);
    err(m);
    if (e?.code === "E_USAGE") return 2;
    if (m.startsWith("E_UNSTABLE_ENTRY") || m.startsWith("E_MANIFEST") || m.startsWith("E_NO_MANIFEST")) return 32;
    if (m.startsWith("E_BACKEND")) return 33;
    if (m.startsWith("E_NOT_INSTALLED")) return 30;
    return 31;
  }
  err("usage: dia service add|remove|list|show|verify|health");
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
      out(`当前是脚本安装（${install}）。推荐切到 npm 全局安装，之后升级都走 npm：`);
      out(`  npm i -g @minonl/dia@latest`);
      out(`  ln -sfn "$(npm prefix -g)/bin/dia" ~/.local/bin/dia   # 让稳定路径指向 npm 安装`);
      out(`（仍要脚本安装：cd ${source || "<dia 仓库>"} && git pull && bun run build && bash install.sh —— 已降级为开发/离线通道）`);
      return 0;
    }
    // npm 12 起默认拦截全局包的安装脚本 → 带上 allow-scripts；老 npm 不认这个 flag 时退回普通安装
    let r = spawnSync("npm", ["i", "-g", "@minonl/dia@latest", "--allow-scripts=@minonl/dia"], { stdio: "inherit" });
    if (r.status !== 0) {
      r = spawnSync("npm", ["i", "-g", "@minonl/dia@latest"], { stdio: "inherit" });
      if (r.status !== 0) { err("E_UPDATE: npm 安装失败（可能需要 sudo 或调整 npm prefix）"); return r.status || 1; }
    }
    out(`已更新到 ${latest}（重新打开终端/会话生效）`);
    // npm 11 起默认屏蔽安装脚本（allowScripts）→ 升级后在本进程内补一次自举，保证「装完即用」
    try {
      const b = defaultMsg.ensure(undefined, { force: true });
      out(b.ok ? `内置能力已同步（${b.kit}）` : `! 内置能力未装配：${b.reason}（修复：dia postinstall）`);
    } catch { /* 自举失败不影响升级结果 */ }
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
  if (cmd === "service") return serviceCli(argv.slice(1));
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
  if (cmd === "graph") return graphCli(argv.slice(1));
  if (cmd === "msg") return msgCli(argv.slice(1));
  if (cmd === "claim" || cmd === "claims" || cmd === "unclaim") return claimsCli(argv);
  if (cmd === "postinstall") {
    // npm/bun 全局安装后自动跑一次（见 scripts/postinstall.mjs）；也可手动补跑
    const quiet = has(argv.slice(1), "--quiet");
    try {
      const r = defaultMsg.ensure(undefined, { force: true });
      if (!quiet) out(r.ok ? `postinstall: kit=${r.kit}` : `postinstall: skipped（${r.reason}）`);
    } catch (e: any) {
      if (!quiet) err(`postinstall: 跳过（${e?.message || e}）`);
    }
    return 0; // 绝不因为自举失败让 npm install 失败
  }
  if (cmd === "migrate") return migrateCli(argv.slice(1));
  if (cmd === "collab") return collabCli(argv.slice(1));
  if (["whoami", "in", "out", "ack", "reply", "close", "show"].includes(cmd)) return collabCli(argv);
  if (cmd === "agents") return agentsCli(argv.slice(1));
  if (cmd === "team") return teamCli(argv.slice(1));
  if (cmd === "job") {
    const rest = argv.slice(1);
    // `dia job status|list`：追一列 health（只读缓存，不执行检查；见 docs/service-noun.md §6）
    if (rest[0] === "status" || rest[0] === "list") {
      const r = runJobCapture(rest);
      if (r.stderr) process.stderr.write(r.stderr);
      const text = service.decorateStatus(r.stdout, (id) => service.readServiceHealth(id));
      if (text) out(text.replace(/\n$/, ""));
      return r.status;
    }
    return runJob(rest);
  }
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
