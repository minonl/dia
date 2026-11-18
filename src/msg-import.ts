// msg-import —— 旧 `~/.dia/msg/<agent>/inbox/*.json` → v2 `~/.dia/collab/inbox/<sid>/`
//
// 2026-11-18 用户拍板：存储**统一到 v2**，老数据**一次性导入**，导入后可用可回复
// （不再是「legacy 只读」那套；`collab.migrateLegacy` 那批 legacy:* 只读数据不在本命令处理范围）
//
// 规则：
//   · 会话标识只从旧 **agent 目录名**里提取 `ses_[A-Za-z0-9]+`（也接受 `session:ses_xxx` 前缀）；
//     提取不到就**报告、不猜**（标题 / cwd / 昵称一律不作数），该目录整体进 skipped 报告
//   · 幂等：同一 id 目标已存在 → 跳过，不覆盖（重跑不重复导入，也不覆盖已读/已回复的状态）
//   · 不删旧文件（旧目录留作第二份；确认无误后由人手动清理）
//   · --dry-run：只报告，不落盘
//   · 导入后的消息**不是 legacy**：state / requires_reply / hops / refs / created_at 原样保留，
//     可 show、可 ack/reply/close；正文缺失 → body_missing 标记，不阻断导入
//
// 已知边界（别当 bug）：旧数据里 `to` 可能是**另一个** agent 目录名；导入只按「文件落在哪个
// inbox」决定收件人（那是 v1 的事实来源），不改写 `to` 字段；改写后的 to 记在 imported_from。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import * as paths from "./paths.ts";
import { log } from "./log.ts";

const KINDS = ["question", "handoff", "notify", "reply"] as const;
type Kind = (typeof KINDS)[number];
const STATES = ["pending", "delivered", "acked", "replied", "needs_info", "closed", "escalated"];
/** 会话标识形状：与 collab.normalizeSessionId 同口径的宽松前缀匹配 */
const SID_RE = /ses_[A-Za-z0-9]+/;

export interface ImportedMessage {
  id: string;
  thread_id: string;
  seq: number;
  from: { session_id: string; display_name?: string };
  to: { session_id: string; display_name?: string };
  kind: Kind;
  subject: string;
  body?: string;
  body_bytes: number;
  body_missing?: boolean;
  refs?: Record<string, string>;
  requires_reply: boolean;
  hops: number;
  created_at: string;
  state: string;
  transport: "file";
  idempotency_key: string;
  schema: 2;
  /** 溯源：原 v1 收件目录名 + 原 to 字段（v2 里 to 已被归一成 sid） */
  imported_from: { agent_dir: string; to: string; file: string; at: string };
}

export interface ImportReport {
  dry_run: boolean;
  /** 扫描到的旧 inbox 条目（含无法导入的） */
  total: number;
  /** 真正新写入（或 dry-run 下「将会写入」） */
  imported: number;
  /** 已存在同 id → 跳过 */
  skipped: number;
  /** 结构性不合格（无 id / 文件损坏） */
  invalid: number;
  /** agent 目录名提取不到 ses_* → 整目录跳过，列出来给人看 */
  unresolved: { agent_dir: string; files: number; reason: string }[];
  /** 导入明细（dry-run 时 available=true 但未落盘） */
  rows: { agent_dir: string; file: string; id: string; to: string; state: string; action: "import" | "skip" | "invalid" }[];
}

const v1Root = () => join(paths.diaHome(), "msg");
const v2InboxRoot = () => join(paths.diaHome(), "collab", "inbox");

/** 从旧 agent 目录名提取会话标识；提不到返回 null（**不猜**）。 */
export function sessionIdFromAgentDir(agentDir: string): string | null {
  const m = SID_RE.exec(String(agentDir || ""));
  return m ? m[0] : null;
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(2).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/** 严格 id 形状（文件名 + id 都必须是安全片名，防路径穿越） */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function toV2(old: any, agentDir: string, sid: string, file: string, at: string): ImportedMessage | null {
  const id = String(old?.id || file.replace(/\.json$/, ""));
  if (!SAFE_ID.test(id) || id.includes("..")) return null;
  const body = typeof old?.body === "string" ? old.body : undefined;
  const fromRaw = String(old?.from || "");
  const fromSid = SID_RE.exec(fromRaw)?.[0] || fromRaw || "legacy:unknown";
  const toRaw = String(old?.to || "");
  const toSid = SID_RE.exec(toRaw)?.[0] || sid; // 旧数据的 to 若本身是别的 agent（非 ses 形状）→ 收件人以「文件落在哪个 inbox」为准
  return {
    schema: 2,
    id,
    thread_id: String(old?.thread_id || `th-import-${id}`),
    seq: Number(old?.seq || 1),
    from: { session_id: fromSid, display_name: fromRaw || undefined },
    to: { session_id: toSid, display_name: toRaw || agentDir },
    kind: (KINDS as readonly string[]).includes(String(old?.kind)) ? (old.kind as Kind) : "notify",
    subject: String(old?.subject ?? "").replace(/[\r\n]+/g, " "),
    body,
    body_bytes: Buffer.byteLength(body || ""),
    body_missing: body === undefined ? true : undefined,
    refs: old?.refs && typeof old.refs === "object" ? old.refs : undefined,
    requires_reply: !!old?.requires_reply,
    hops: Number(old?.hops || 0),
    created_at: String(old?.created_at || at),
    state: STATES.includes(String(old?.state)) ? String(old?.state) : "pending",
    transport: "file",
    idempotency_key: String(old?.idempotency_key || `${old?.thread_id || `th-import-${id}`}#${old?.seq || 1}`),
    imported_from: { agent_dir: agentDir, to: toRaw, file, at },
  };
}

/**
 * 一次性导入旧 v1 邮箱。幂等、不删旧文件、默认不写盘（需显式 apply）。
 * `apply: false`（默认）= dry-run，只报告。
 */
export function importLegacyV1(opts: { dryRun?: boolean; from?: string } = {}): ImportReport {
  const dry = opts.dryRun !== false;
  const root = opts.from || v1Root();
  const report: ImportReport = { dry_run: dry, total: 0, imported: 0, skipped: 0, invalid: 0, unresolved: [], rows: [] };
  if (!existsSync(root)) {
    log.verbose("import: 旧邮箱不存在，无事可做", { root });
    return report;
  }
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  log.debug("import: 扫描旧邮箱", { root, dirs: entries.length, dry_run: dry });
  const at = new Date().toISOString();
  for (const agentDir of entries) {
    const inbox = join(root, agentDir, "inbox");
    if (!existsSync(inbox)) { log.verbose("import: 目录无 inbox，跳过", { agent_dir: agentDir }); continue; }
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    if (!files.length) continue;
    report.total += files.length;
    const sid = sessionIdFromAgentDir(agentDir);
    if (!sid) {
      report.unresolved.push({ agent_dir: agentDir, files: files.length, reason: "目录名里没有 ses_[A-Za-z0-9]+" });
      log.warn("import: 提取不到会话标识，整目录跳过（不猜）", { agent_dir: agentDir, files: files.length });
      for (const file of files) report.rows.push({ agent_dir: agentDir, file, id: "(unknown)", to: "-", state: "-", action: "invalid" });
      continue;
    }
    for (const file of files) {
      const target = join(v2InboxRoot(), sid, `${file.replace(/\.json$/, "")}.json`);
      const old = readJson<any>(join(inbox, file));
      const msg = old ? toV2(old, agentDir, sid, file, at) : null;
      if (!msg) {
        report.invalid++;
        report.rows.push({ agent_dir: agentDir, file, id: "(invalid)", to: "-", state: "-", action: "invalid" });
        log.warn("import: 文件不可解析或缺合法 id", { agent_dir: agentDir, file });
        continue;
      }
      // 幂等判定：目标已存在 → 跳过（不覆盖；已读/已回复的状态必须保住）
      const already = existsSync(target) || existsSync(join(v2InboxRoot(), sid, `${msg.id}.json`));
      if (already) {
        report.skipped++;
        report.rows.push({ agent_dir: agentDir, file, id: msg.id, to: msg.to.session_id, state: msg.state, action: "skip" });
        log.verbose("import: 目标已存在，跳过", { id: msg.id, sid, target });
        continue;
      }
      report.imported++;
      report.rows.push({ agent_dir: agentDir, file, id: msg.id, to: msg.to.session_id, state: msg.state, action: "import" });
      log.info("import: 导入一条", { id: msg.id, from_dir: agentDir, to: sid, state: msg.state, body_bytes: msg.body_bytes, dry_run: dry });
      if (dry) continue;
      writeAtomic(join(v2InboxRoot(), sid, `${msg.id}.json`), JSON.stringify(msg, null, 1) + "\n");
    }
  }
  log.debug("import: 完成", { ...report, rows: undefined });
  return report;
}

export interface StorageAnalysis {
  v2: {
    root: string;
    sessions: number;
    messages: number;
    by_state: Record<string, number>;
    legacy_ids: string[];
    by_creator_host: Record<string, number>;
  };
  v1: {
    root: string;
    present: boolean;
    agents: { agent_dir: string; session_id: string | null; files: number; importable: number; already_imported: number }[];
  };
  events: { dir: string; files: number; lines: number; bad_lines: number; first_month: string | null; last_month: string | null };
  verdict: string[];
}

/** 只读存储体检：v1 还有多少、能不能导、v2 现状、事件流健康度。绝不写盘。 */
export function analyzeStorage(opts: { from?: string } = {}): StorageAnalysis {
  const v1 = opts.from || v1Root();
  const v2root = join(paths.diaHome(), "collab");
  const inboxRoot = v2InboxRoot();

  const msgFiles: { sid: string; file: string; m: any }[] = [];
  if (existsSync(inboxRoot)) {
    for (const sid of readdirSync(inboxRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      for (const file of readdirSync(join(inboxRoot, sid)).filter((f) => f.endsWith(".json"))) {
        msgFiles.push({ sid, file, m: readJson<any>(join(inboxRoot, sid, file)) });
      }
    }
  }
  const byState: Record<string, number> = {};
  const byHost: Record<string, number> = {};
  const legacyIds: string[] = [];
  for (const { sid, m } of msgFiles) {
    const st = String(m?.state ?? "(unreadable)");
    byState[st] = (byState[st] || 0) + 1;
    if (m?.legacy) legacyIds.push(String(m.id ?? sid));
    const host = String(m?.from?.display_name || "").match(/^([a-z]+):/)?.[1] || "(unknown)";
    byHost[host] = (byHost[host] || 0) + 1;
  }

  const agents: StorageAnalysis["v1"]["agents"] = [];
  if (existsSync(v1)) {
    for (const agentDir of readdirSync(v1, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const inbox = join(v1, agentDir, "inbox");
      const files = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith(".json")) : [];
      const sid = sessionIdFromAgentDir(agentDir);
      let already = 0;
      if (sid) {
        for (const f of files) if (existsSync(join(inboxRoot, sid, f))) already++;
      }
      agents.push({ agent_dir: agentDir, session_id: sid, files: files.length, importable: sid ? files.length - already : 0, already_imported: already });
    }
  }

  const evDir = join(v2root, "events");
  let evFiles: string[] = [];
  let lines = 0, bad = 0;
  if (existsSync(evDir)) {
    evFiles = readdirSync(evDir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of evFiles) {
      for (const l of readFileSync(join(evDir, f), "utf8").split("\n")) {
        if (!l.trim()) continue;
        lines++;
        try { JSON.parse(l); } catch { bad++; }
      }
    }
  }

  const verdict: string[] = [];
  const unresolved = agents.filter((a) => !a.session_id);
  const pendingImport = agents.reduce((n, a) => n + a.importable, 0);
  if (!agents.length) verdict.push("v1 邮箱为空或不存在：已完全统一到 v2（或从未用过 v1）");
  if (pendingImport) verdict.push(`v1 还有 ${pendingImport} 条可导入：跑 dia msg migrate --apply`);
  if (unresolved.length) verdict.push(`${unresolved.length} 个 v1 目录名提取不到 ses_*（需人工判断归属，不会被自动导入）`);
  if (legacyIds.length) verdict.push(`v2 里仍有 ${legacyIds.length} 条 legacy 消息（只读，不可 ack/reply）`);
  if (bad) verdict.push(`事件流有 ${bad} 行无法解析（trace 会跳过它们）`);
  if (!verdict.length) verdict.push("存储状态正常");

  return {
    v2: {
      root: v2root,
      sessions: new Set(msgFiles.map((x) => x.sid)).size,
      messages: msgFiles.length,
      by_state: byState,
      legacy_ids: legacyIds,
      by_creator_host: byHost,
    },
    v1: { root: v1, present: existsSync(v1), agents },
    events: {
      dir: evDir,
      files: evFiles.length,
      lines,
      bad_lines: bad,
      first_month: evFiles.length ? evFiles[0].replace(/\.jsonl$/, "") : null,
      last_month: evFiles.length ? evFiles[evFiles.length - 1].replace(/\.jsonl$/, "") : null,
    },
    verdict,
  };
}
