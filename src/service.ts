// service.ts — 服务（service）：可托管的执行体（设计见 docs/service-noun.md）
//
// 分层：persona 决定「你是谁」，kit 决定「你会什么」，service 决定「你在后台干什么、活没活着」。
// 本切片的边界（最小可验证集合）：
//   · kind=service 清单校验（共用 dia.json / schema:1 的顶层规则，按 kind 分派专属字段）
//   · `dia service verify`（清单 + entry 稳定入口 + job registry 漂移检测）
//   · `dia service health`（healthcheck 专用码域 0/20/21 判定，实时执行一次）
// 不在本切片：`add/remove/list`、调度落地（`svc-<id>-health` 交给 job backend）、去抖状态机写入。
//
// 两套码域**物理分离**（§4.1）：
//   · contract.exit —— 服务自己的业务/生命周期语义（如 `0=ok/2=retry`），dia 不解读；
//   · healthcheck   —— 专用码域 0=ok / 20=degraded / 21=fail（外加 124=timeout、信号=crash），
//                      **只此一套**参与健康判定。contract.exit 的 2/3 绝不借用给 health。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { jobBin } from "./job.ts";
import * as paths from "./paths.ts";

// ── 清单（dia.json kind=service）──────────────────────────────────────────────

/**
 * agent 型入口（§14.2）：不写死命令，只声明「哪套 ACP 宿主 + 哪个 profile」。
 * 命令由 host 推导（见 acpAgentCommand），**不允许同时声明 cmd**（入口互斥，§14.6）。
 */
export interface ServiceAgentEntry {
  /** ACP 实现：dsh | opencode（其它值 → E_MANIFEST） */
  host: string;
  /** 宿主的 profile 名（不复制 persona 内容，只引用；缺省用宿主默认） */
  profile?: string;
  /** 可选：仅做归属校验，不注入内容 */
  persona?: string;
}

/** 入口二选一：`cmd`（脚本型）或 `agent`（agent 型）。 */
export interface ServiceEntry {
  cmd?: string;
  agent?: ServiceAgentEntry;
}

/** ACP 健康检查（§14.3）：不要求 cmd，判据 = initialize + session/new。 */
export interface ServiceHealthcheck {
  /** 缺省 "script"（向后兼容）；"acp" = 走 runAcpHealth */
  kind?: "script" | "acp";
  cmd?: string;
  /** 默认 1800s；须 ≥60s、整分 */
  interval?: number;
  /** 默认 60s；由 dia / job wrapper 包超时（exit 124） */
  timeout?: number;
  ok_exit?: number[];
  degraded_exit?: number[];
  fail_exit?: number[];
  /** 默认 2：连续 N 次同结果才切换状态（本切片只做校验） */
  debounce?: number;
}

export interface ServiceLifecycle {
  type: "periodic" | "bounded" | "service";
  /** periodic 的间隔（秒）；cron 约束见 checkCronInterval */
  interval?: number;
  /** 归属主机（多机部署）；比对时去 `.local` 并转小写 */
  target?: string;
}

/** 与调用方/事件源的约定：**只声明，不执行、不参与 health 判定**。 */
export interface ServiceContract {
  stdin?: "json" | "text" | "none";
  exit?: string;
  idempotent_by?: string;
}

export interface ServiceManifest {
  schema: number;
  kind: "service";
  id: string;
  version: string;
  entry: ServiceEntry;
  lifecycle: ServiceLifecycle;
  contract?: ServiceContract;
  healthcheck?: ServiceHealthcheck;
  kits?: string[];
  requires?: Record<string, string>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const LIFECYCLE_TYPES = new Set(["periodic", "bounded", "service"]);
const STDIN_TYPES = new Set(["json", "text", "none"]);
const ACP_HOSTS = ["dsh", "opencode"] as const;
export type AcpHost = (typeof ACP_HOSTS)[number];
const HEALTHCHECK_KINDS = new Set(["script", "acp"]);

const isPlainObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** 非空字符串（去掉首尾空白后） */
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * agent 型入口的命令（§14.2 / §14.3）：只在清单这一处推导，健康检查与 job 拉起点用同一份。
 *   · dsh（缺省 profile）→ `dsh acp`
 *   · dsh + profile p   → `dsh --profile p acp`
 *   · opencode          → `opencode acp`（opencode 无 profile 概念，给了 → E_MANIFEST 由校验挡下）
 */
export function acpAgentCommand(agent: ServiceAgentEntry): string[] {
  if (!ACP_HOSTS.includes(agent?.host as AcpHost)) throw new Error(`E_MANIFEST: entry.agent.host must be ${ACP_HOSTS.join("|")}`);
  const profile = agent.profile?.trim();
  if (agent.host === "dsh") return ["dsh", ...(profile ? ["--profile", profile] : []), "acp"];
  return ["opencode", "acp"];
}

/** 入口是 agent 型？（互斥校验已保证不会和 cmd 同时出现） */
export const isAgentEntry = (e: ServiceEntry | undefined): e is ServiceEntry & { agent: ServiceAgentEntry } =>
  !!e && e.agent !== undefined && e.agent !== null;

/** 健康检查类型：缺省 script（向后兼容，§14.6）。 */
export const healthcheckKind = (hc?: ServiceHealthcheck): "script" | "acp" => hc?.kind ?? "script";

/** 脚本型入口解析用的命令：没有 cmd（agent 型）时返回空串，绝不把 undefined 塞给 resolveEntry。 */
export const entryCmdOf = (svc: ServiceManifest): string => svc.entry.cmd ?? "";

/**
 * 校验 entry.agent 形状（host 枚举 / profile 与 host 的搭配 / persona 归属字段）。
 * 值与只校验不推断：`profile: "  "` 这种「看起来没写」的串直接拒（摊成空串会让命令悄悄退化成宿主默认）。
 */
function checkAgentEntry(a: any): ServiceAgentEntry {
  if (!isPlainObject(a)) throw new Error("E_MANIFEST: entry.agent must be an object");
  if (!ACP_HOSTS.includes(a.host)) throw new Error(`E_MANIFEST: entry.agent.host must be ${ACP_HOSTS.join("|")}`);
  for (const k of ["profile", "persona"] as const) {
    if (a[k] !== undefined && !isNonEmptyString(a[k])) throw new Error(`E_MANIFEST: entry.agent.${k} must be a non-empty string`);
  }
  // opencode 没有 profile 概念：「写上了」比「忽略了」更危险（人以为生效了），直接拒绝
  if (a.host !== "dsh" && a.profile !== undefined) {
    throw new Error(`E_MANIFEST: entry.agent.profile 只适用于 host=dsh（${a.host} 没有 profile）`);
  }
  return a as ServiceAgentEntry;
}

/**
 * entry 入口二选一（§14.6）：`cmd`（脚本型）与 `agent`（agent 型）**互斥且必选其一**。
 * · 同时给 → E_MANIFEST（不猜谁优先：猜错就是「装了半套」）；
 * · 都没有 → E_MANIFEST（没有入口的服务无从托管）；
 * · agent 型光声明不够：healthcheck 必须 `kind:"acp"`；`kind:"acp"` 反过来也只能配 agent 型
 *   （否则 health 会去跑一条不存在的命令，永远 crash）。
 */
function checkEntry(entry: any): ServiceEntry {
  if (!isPlainObject(entry)) throw new Error("E_MANIFEST: entry required");
  const hasCmd = entry.cmd !== undefined && entry.cmd !== null;
  const hasAgent = entry.agent !== undefined && entry.agent !== null;
  if (hasCmd && hasAgent) throw new Error("E_MANIFEST: entry.cmd 与 entry.agent 互斥，只能声明其一");
  if (!hasCmd && !hasAgent) throw new Error("E_MANIFEST: entry.cmd required（脚本型）或 entry.agent（agent 型）");
  if (hasCmd) {
    if (typeof entry.cmd !== "string" || !entry.cmd.trim()) throw new Error("E_MANIFEST: entry.cmd required");
  } else {
    checkAgentEntry(entry.agent);
  }
  return entry as ServiceEntry;
}


/** 稳定入口目录（与 packages/job/lib/policy.sh 同一解析：`${DIA_JOB_ENTRY_DIR:-<job root>/bin}`）。 */
export function entryDir(): string {
  return process.env.DIA_JOB_ENTRY_DIR || join(jobRoot(), "bin");
}

/** job 数据根：显式 DIA_JOB_ROOT > dia 数据根下的 job/。 */
export function jobRoot(): string {
  return process.env.DIA_JOB_ROOT || paths.jobRoot();
}

/** job registry（packages/job：`tasks/registry.json`，键为任务名，**唯一列表**）。 */
export function registryPath(): string {
  return process.env.DIA_SERVICE_REGISTRY || join(jobRoot(), "tasks", "registry.json");
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
/** 退出码表：非负整数（`ok_exit: [0]` 是默认值，0 必须合法）。 */
const exitList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0);

/** 主机名归一：去 `.local` 后缀 + 小写（D3 比对口径）。 */
export function normalizeHost(h: string): string {
  return h.trim().replace(/\.local$/i, "").toLowerCase();
}

/**
 * lifecycle.interval 能否被 cron 表达（§3 / V6）：
 * `>=60s` 且整分；用星号分 N 时 N 必须整除 1440；>23h 表达不了。
 * 返回 null 表示可表达，否则返回原因（调用方映射为 E_BACKEND）。
 */
export function checkCronInterval(interval: number): string | null {
  if (typeof interval !== "number" || !Number.isFinite(interval)) return "interval 必须是数字（秒）";
  if (!Number.isInteger(interval)) return "interval=" + interval + "s 不是整数秒：cron 无法表达";
  if (interval < 60) return "interval < 60s：cron 最小粒度是 1 分钟";
  if (interval % 60 !== 0) return "interval=" + interval + "s 不是整分：cron 无法表达";
  const minutes = interval / 60;
  if (minutes > 23 * 60) return "interval=" + interval + "s > 23h：cron 无法表达";
  if (1440 % minutes !== 0) {
    return "interval=" + interval + "s 对应 */" + minutes + " 分钟，不整除 1440：cron 无法表达（安装期 E_BACKEND，不静默改间隔）";
  }
  return null;
}

/** 解析 healthcheck 的码表：默认 0/20/21，可按字段覆盖。 */
export function healthCodes(hc?: ServiceHealthcheck): { ok: number[]; degraded: number[]; fail: number[] } {
  return {
    ok: hc?.ok_exit ?? [0],
    degraded: hc?.degraded_exit ?? [20],
    fail: hc?.fail_exit ?? [21],
  };
}

const LEVELS = ["ok", "degraded", "fail"] as const;

function checkHealthcheck(hc: any): ServiceHealthcheck {
  if (hc === null || typeof hc !== "object" || Array.isArray(hc)) throw new Error("E_MANIFEST: healthcheck must be an object");
  if (hc.kind !== undefined && !HEALTHCHECK_KINDS.has(hc.kind)) throw new Error("E_MANIFEST: healthcheck.kind must be script|acp");
  // kind 缺省 = script（向后兼容，§14.6）；只有脚本型要 cmd，acp 型的判据是 initialize + session/new
  if (healthcheckKind(hc) === "script") {
    if (typeof hc.cmd !== "string" || !hc.cmd.trim()) throw new Error("E_MANIFEST: healthcheck.cmd required");
  } else if (hc.cmd !== undefined) {
    throw new Error("E_MANIFEST: healthcheck.kind=acp 不得再声明 cmd（判据是 initialize + session/new，不是外部脚本）");
  }
  if (hc.interval !== undefined) {
    const why = checkCronInterval(hc.interval);
    if (why) throw new Error(`E_MANIFEST: healthcheck.interval: ${why}`);
  }
  if (hc.timeout !== undefined && !isPositiveInt(hc.timeout)) throw new Error("E_MANIFEST: healthcheck.timeout must be a positive integer (seconds)");
  for (const k of ["ok_exit", "degraded_exit", "fail_exit"] as const) {
    if (hc[k] !== undefined && !exitList(hc[k])) throw new Error(`E_MANIFEST: healthcheck.${k} must be an array of non-negative integers`);
  }
  if (hc.debounce !== undefined && !isPositiveInt(hc.debounce)) throw new Error("E_MANIFEST: healthcheck.debounce must be a positive integer");
  const codes = healthCodes(hc);
  for (let i = 0; i < LEVELS.length; i++) {
    for (let j = i + 1; j < LEVELS.length; j++) {
      const a = codes[LEVELS[i]], b = codes[LEVELS[j]];
      if (a.some((n) => b.includes(n))) throw new Error("E_MANIFEST: healthcheck exit codes overlap across ok/degraded/fail");
    }
  }
  return hc;
}

/** 结构性校验（形状/类型/码表），不看文件系统；入口是否「稳定」由 resolveEntry 负责。 */
export function validateServiceManifest(m: any): ServiceManifest {
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw new Error("E_MANIFEST: dia.json must be an object");
  if (m.schema !== 1) throw new Error("E_MANIFEST: unsupported schema");
  if (m.kind !== "service") throw new Error("E_MANIFEST: kind must be service");
  if (!m.id || !ID_RE.test(m.id)) throw new Error("E_MANIFEST: bad id");
  if (!m.version || !VERSION_RE.test(m.version)) throw new Error("E_MANIFEST: bad version");

  // 入口互斥（§14.6）：entry.cmd 与 entry.agent 只能声明其一
  checkEntry(m.entry);
  const agentEntry = isAgentEntry(m.entry);
  if (agentEntry && healthcheckKind(m.healthcheck) !== "acp") {
    throw new Error('E_MANIFEST: entry.agent 必须配 healthcheck.kind="acp"（脚本型 healthcheck 无 cmd 可执行）');
  }
  if (!agentEntry && m.healthcheck && healthcheckKind(m.healthcheck) === "acp") {
    throw new Error('E_MANIFEST: healthcheck.kind="acp" 只适用于 entry.agent 型服务');
  }

  if (m.lifecycle === null || typeof m.lifecycle !== "object" || Array.isArray(m.lifecycle)) throw new Error("E_MANIFEST: lifecycle required");
  if (!LIFECYCLE_TYPES.has(m.lifecycle.type)) throw new Error("E_MANIFEST: lifecycle.type must be periodic|bounded|service");
  if (m.lifecycle.type === "periodic") {
    if (m.lifecycle.interval === undefined) throw new Error("E_MANIFEST: lifecycle.interval required for periodic");
    const why = checkCronInterval(m.lifecycle.interval);
    if (why) throw new Error(`E_MANIFEST: lifecycle.interval: ${why}`);
  }
  if (m.lifecycle.target !== undefined && (typeof m.lifecycle.target !== "string" || !m.lifecycle.target.trim())) {
    throw new Error("E_MANIFEST: lifecycle.target must be a non-empty string");
  }

  // contract 只声明；即便它的 2=retry 与 health 码"长得像"也不报错（两套码域分离，B1）
  if (m.contract !== undefined) {
    if (m.contract === null || typeof m.contract !== "object" || Array.isArray(m.contract)) throw new Error("E_MANIFEST: contract must be an object");
    if (m.contract.stdin !== undefined && !STDIN_TYPES.has(m.contract.stdin)) throw new Error("E_MANIFEST: contract.stdin must be json|text|none");
    for (const k of ["exit", "idempotent_by"] as const) {
      if (m.contract[k] !== undefined && typeof m.contract[k] !== "string") throw new Error(`E_MANIFEST: contract.${k} must be a string`);
    }
  }
  if (m.healthcheck !== undefined) checkHealthcheck(m.healthcheck);
  if (m.kits !== undefined && !(Array.isArray(m.kits) && m.kits.every((k: unknown) => typeof k === "string"))) {
    throw new Error("E_MANIFEST: kits must be a string array");
  }
  if (m.requires !== undefined && (m.requires === null || typeof m.requires !== "object" || Array.isArray(m.requires))) {
    throw new Error("E_MANIFEST: requires must be an object");
  }
  return m as ServiceManifest;
}

/** 读 service 清单：无 dia.json → E_NO_MANIFEST（adopted 服务，§7）。 */
export function readServiceManifest(dir: string): ServiceManifest {
  const p = join(dir, "dia.json");
  if (!existsSync(p)) throw new Error(`E_NO_MANIFEST: dia.json not found in ${dir}（adopted 服务需先补 dia.json）`);
  let raw: any;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error("E_MANIFEST: invalid json"); }
  return validateServiceManifest(raw);
}

// ── 入口（稳定入口）──────────────────────────────────────────────────────────

export type EntryKind = "repo" | "ref";

export interface EntryResolution {
  /** `repo`：仓内相对路径（add 时链到 DIA_JOB_ENTRY_DIR）；`ref`：已安装的 ref-entry */
  kind: EntryKind;
  /** 解析后的绝对路径 */
  path: string;
}

/**
 * 入口判定（§3 / §7 / C5）：
 *  · 仓内相对路径（`bin/*`）→ repo；
 *  · `$DIA_JOB_ENTRY_DIR/*` 下已安装的 ref-entry → ref（允许符号链接，verify 校验目标）；
 *  · 其它绝对路径 / `..` 穿越 / worktree 路径 → E_UNSTABLE_ENTRY。
 *     历史教训：把 checkout 绝对路径写进入口，清理 worktree 后服务 127 静默死亡。
 */
export function resolveEntry(cmd: string, baseDir: string): EntryResolution {
  const dir = entryDir();
  if (isAbsolute(cmd)) {
    const abs = resolve(cmd);
    const relToEntryDir = relative(resolve(dir), abs);
    const inEntryDir = relToEntryDir !== "" && !relToEntryDir.startsWith("..") && !isAbsolute(relToEntryDir);
    const inWorktree = abs.split(sep).some((seg) => /-(worktree|wt)$/i.test(seg));
    if (inEntryDir && !inWorktree) return { kind: "ref", path: abs };
    throw new Error(`E_UNSTABLE_ENTRY: 禁止 checkout 绝对路径 / worktree 路径（${cmd}）；用仓内相对路径或 ${dir}/* 下的 ref-entry`);
  }
  if (cmd.split(/[\\/]/).includes("..")) throw new Error(`E_UNSTABLE_ENTRY: 入口不得包含 ..（${cmd}）`);
  const abs = resolve(baseDir, cmd);
  if (relative(resolve(baseDir), abs).startsWith("..")) throw new Error(`E_UNSTABLE_ENTRY: 入口越出仓根（${cmd}）`);
  return { kind: "repo", path: abs };
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    return process.platform === "win32" ? true : (st.mode & 0o111) !== 0;
  } catch { return false; }
}

/** lstat 判定（stat 会跟随软链：断链/普通文件都会判错）。 */
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const shaFile = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

// ── healthcheck 码域（0 / 20 / 21）────────────────────────────────────────────

/**
 * healthcheck 的**原始判定**（dia 内部用）：在四态之外多一个 `crash`（判据不可用）。
 * crash 不是台账状态（§4.4），由 transition 消化成「保持上次状态 / 连续 N 次降 degraded」。
 */
export type HealthRaw = "ok" | "degraded" | "fail" | "crash";

/** dia 侧状态只有四态：ok / degraded / fail / unknown（unknown = 无可用结果，由新鲜度计算）。 */
export type HealthLevel = "ok" | "degraded" | "fail";
export const UNKNOWN: "unknown" = "unknown";
export type HealthState = HealthLevel | typeof UNKNOWN;

export interface HealthJudgement {
  state: HealthRaw;
  exit: number | null;
  /** 被信号杀（crash 的一种） */
  signal?: string;
  /** true = 由 wrapper 的 timeout 从 124 判定（不杀服务） */
  timeout: boolean;
  detail: string;
  /** 原始码是否属 health 码域；false = 判据不可用 */
  inDomain: boolean;
}

const SIGNALS: Record<number, string> = { 6: "SIGABRT", 9: "SIGKILL", 11: "SIGSEGV", 13: "SIGPIPE", 15: "SIGTERM" };

/**
 * 退出码 → 健康状态（§4.1）。**只看 health 专用码域**：
 *   0(ok) / 20(degraded) / 21(fail) / 124(timeout→degraded) / 被信号杀死或其它非 0 码 → crash。
 * contract.exit 的 `0=ok/2=retry` 不参与：2 在这里是 crash（不在域内），不会被读成 degraded。
 */
export function judgeHealth(
  exit: number | null,
  opts: { signal?: string | number | null; codes?: { ok: number[]; degraded: number[]; fail: number[] } } = {},
): HealthJudgement {
  const codes = opts.codes ?? healthCodes();
  const sig = opts.signal;
  if (sig !== null && sig !== undefined && sig !== "" && sig !== 0) {
    const name = typeof sig === "number" ? SIGNALS[sig] ?? `signal ${sig}` : String(sig);
    return { state: "crash", exit: null, signal: name, timeout: false, detail: `killed by ${name}`, inDomain: false };
  }
  if (exit === null) return { state: "crash", exit: null, timeout: false, detail: "no exit status", inDomain: false };
  if (codes.ok.includes(exit)) return { state: "ok", exit, timeout: false, detail: "", inDomain: true };
  if (codes.degraded.includes(exit)) return { state: "degraded", exit, timeout: false, detail: "", inDomain: true };
  if (codes.fail.includes(exit)) return { state: "fail", exit, timeout: false, detail: "", inDomain: true };
  // wrapper 的 timeout(1)：124 → degraded（明细 timeout），与 20 同权；不杀服务本身
  if (exit === 124) return { state: "degraded", exit, timeout: true, detail: "timeout", inDomain: true };
  return { state: "crash", exit, timeout: false, detail: `exit=${exit} outside health code domain (0/20/21)`, inDomain: false };
}

/** `dia service health` 的进程退出码（§5 / C3）：0 ok · 30 degraded · 1 fail · 31 判据不可用 · 2 用法错误。 */
export const HEALTH_EXIT = { ok: 0, degraded: 30, fail: 1, crash: 31, usage: 2 } as const;

export function healthExitCode(j: HealthJudgement): number {
  return HEALTH_EXIT[j.state];
}

// ── 契约常量（§3 / §4）───────────────────────────────────────────────────────

export const DEFAULT_HEALTH_INTERVAL = 1800;
export const DEFAULT_HEALTH_TIMEOUT = 60;
export const DEFAULT_DEBOUNCE = 2;
/** 新鲜度窗口 = interval × 1.5（§4.6）；整数秒，避免与台账 ts 比较时引入小数 */
export const STALE_FACTOR = 1.5;
export const MIN_HEALTH_INTERVAL = 60;

const healthInterval = (hc?: ServiceHealthcheck) => hc?.interval ?? DEFAULT_HEALTH_INTERVAL;
const healthDebounce = (hc?: ServiceHealthcheck) => hc?.debounce ?? DEFAULT_DEBOUNCE;
export const staleAfter = (hc?: ServiceHealthcheck) => Math.floor(healthInterval(hc) * STALE_FACTOR);

// ── 去抖状态机（§4.3 / §4.4）──────────────────────────────────────────────────
//
// **唯一写入方** = 执行健康检查的那一次（job wrapper 周期执行 / `dia service health` 手动执行）。
// 读取方（list / show / status）只读台账里已决定的 `state`，不重算。
//
// 状态只有 ok / degraded / fail / unknown：
//   · unknown = 无可用结果（从未检查 / 过期），由读取方按新鲜度计算，**不由本函数产生**；
//   · crash（检查自身崩溃）不是状态：保持上一次状态，连续 debounce 次才降为 degraded（明细「判据不可用」）。

/** `state.jsonl` 里一条 `kind:"health"` 行（§4.5）。 */
export interface HealthRecord {
  ts: number;
  kind: "health";
  service: string;
  /** 代际：add / 重装时变；旧代际的行不参与新代际的去抖 */
  gen: string;
  source: "schedule" | "manual";
  /** 已决定的状态（唯一写入方算好）。unknown 只在「无任何有效结果」时出现 */
  state: HealthState;
  /** 本轮原始结论（含 crash） */
  candidate: HealthState;
  /** 候选已连续出现的次数 */
  streak: number;
  raw: HealthState;
  exit: number | null;
  timeout: boolean;
  detail: string;
  /** 结构化输出里的 checks（可选，原样透传，不解读） */
  checks?: unknown[];
  /** 判据不可用时的原因（连续崩溃 → 明细「判据不可用」）；恢复正常后清空 */
  last_error?: string;
}

export interface TransitionInput {
  service: string;
  gen: string;
  source: "schedule" | "manual";
  ts: number;
  judgement: HealthJudgement;
  debounce?: number;
  /** 结构化输出（可选，只原样记录） */
  checks?: unknown[];
}

/**
 * 一条 `kind:"health"` 行，且 `state` 是**已决定**的三态之一。
 *
 * 为什么不再只校验 `typeof state === "string"`：台账是追加写 + 多写入方（schedule / manual 交错），
 * 末尾还可能是半写行。若 state 缺失/被截断/写成 `"unknown"`/写坏成任意字符串，旧口径会把它当「最近一条」，
 * 读取方于是显示成 `unknown (never)` —— 等于把一条有效结果**静默丢失**。
 * 现在：只有 ok/degraded/fail 才是「可用结果」，其余（含 crash 行在首次巡检时留下的 unknown、
 * 以及半写/坏行）一律跳过，继续向前找上一条有效记录（与 findLastHealth 口径一致）。
 */
const isRecord = (v: unknown): v is HealthRecord =>
  !!v && typeof v === "object" && (v as any).kind === "health" &&
  ((v as any).state === "ok" || (v as any).state === "degraded" || (v as any).state === "fail");

// ── 单行索引（`dia job status` 的 health 列：零执行、不做全文件解析）──────────────
//
// 台账是**追加写**的：每行 `{"ts":…,"kind":"health",…}`，`ts` 与 `kind` 都在行首。
// 用字符串扫描取这两个字段，避免对每个服务都 `JSON.parse` 整份台账（N=50 时是千行级）。
// 行序 = 写入序；先比 ts，相等再比行号（ts 同秒时最后写的才算最新）。
// 任何字段缺失/坏行 → indexOfLine 返回 null（= 无记录 → unknown (never)），崩溃留给下一次检查写新行。

export type HealthPoint = { file: string; line: number; ts: number; kind: string };

const TS_RE = /"ts"\s*:\s*(-?\d+)/;
const KIND_RE = /"kind"\s*:\s*"([A-Za-z0-9_-]+)"/;

/** 首尾都切过后再解析（截断/半写行只会产生空串 → null），绝不抛错。 */
export function parseStateLine(line: string): { ts: number; kind: string } | null {
  const head = line.slice(0, 256), tail = line.slice(-256);
  const ts = TS_RE.exec(head)?.[1] ?? TS_RE.exec(tail)?.[1];
  const kind = KIND_RE.exec(head)?.[1] ?? KIND_RE.exec(tail)?.[1];
  if (!ts || !kind) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? { ts: n, kind } : null;
}

/** 读一份台账的 health 行索引（文件不存在/不可读 → 空数组）。 */
export function indexHealthFile(file: string): HealthPoint[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const out: HealthPoint[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const p = parseStateLine(lines[i]);
    if (p && p.kind === "health") out.push({ file, line: i, ts: p.ts, kind: p.kind });
  }
  return out;
}

/**
 * 取上一条**有效**记录：同服务、同代际、state 在 ok/degraded/fail 内。
 * 旧代际行、无匹配时的空行一律跳过（保证 `[null, null]` 不会把结果读成 ok）。
 */
export function findLastHealth(lines: unknown[], service: string, gen: string): HealthRecord | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i];
    if (!isRecord(r)) continue;
    if (r.service !== service || r.gen !== gen) continue;
    if (r.state !== "ok" && r.state !== "degraded" && r.state !== "fail") continue;
    return r as HealthRecord;
  }
  return null;
}

/**
 * 去抖（§4.3，统一规则）：
 * · 首次结果（无上一条）直接生效，不走去抖；
 * · 非 crash：与**已决定状态**比较——相同 → 计数清零；不同 → 候选计数 +1，满 debounce 才切换，否则保持；
 * · crash：不改变状态，只累加连续崩溃计数；满 debounce 次且状态还不是 degraded → 切 degraded（「判据不可用」）；
 *   崩溃后恢复 → last_error 清除。
 * 返回值即写入台账的行（`gen` 代际由调用方保证一致）。
 */
export function transition(prev: HealthRecord | null, input: TransitionInput): HealthRecord {
  const debounce = Math.max(1, input.debounce ?? DEFAULT_DEBOUNCE);
  const j = input.judgement;
  const base = {
    ts: input.ts,
    kind: "health" as const,
    service: input.service,
    gen: input.gen,
    source: input.source,
    exit: j.exit,
    timeout: j.timeout,
  };
  const checks = input.checks && input.checks.length ? { checks: input.checks } : {};

  if (j.state === "crash") {
    const streak = prev && prev.candidate === "crash" ? prev.streak + 1 : 1;
    const escalate = streak >= debounce;
    let state: HealthState = prev?.state ?? UNKNOWN;
    let detail = prev?.detail ?? "";
    if (escalate && state !== "degraded") { state = "degraded"; detail = "判据不可用（healthcheck 连续崩溃）"; }
    return {
      ...base, state, candidate: "crash", streak, raw: "crash",
      detail: detail || j.detail,
      last_error: j.detail,
      ...checks,
    };
  }

  const level = j.state as HealthLevel;
  let state: HealthState;
  let streak: number;
  let detail = j.detail;
  if (!prev) {
    state = level; streak = 1;
  } else if (prev.state === level) {
    state = level; streak = 0;
  } else {
    streak = prev.candidate === level ? prev.streak + 1 : 1;
    if (streak >= debounce) state = level;
    else state = prev.state;
  }
  return { ...base, state, candidate: level, streak, raw: level, detail: detail ?? "", ...checks };
}

// ── 新鲜度（§4.6）─────────────────────────────────────────────────────────────

export type HealthView = {
  /** 展示用状态：ok / degraded / fail / unknown；**adopted 服务用 n/a**（§7 三态口径） */
  health: HealthState | "n/a";
  /** 展示后缀：adopted / no healthcheck / never / stale …（区分 n/a 的两种来源） */
  note: "adopted" | "no healthcheck" | "never" | "stale" | "";
  stale: boolean;
  checked_at: number | null;
  /** 距最近结果秒数 */
  age: number | null;
  /** 展示串：`ok (5m ago)` / `unknown (stale 47m)` / `unknown (never)` / `n/a (adopted)` */
  label: string;
}

export function formatAge(sec: number): string {
  if (sec < 90) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/**
 * 只读缓存算展示状态（零执行）：超 interval 乘 1.5 无新结果 → unknown (stale …)，**不显示旧 ok**。
 * · record 为空 → unknown (never)；
 * · 清单无 healthcheck → n/a (no healthcheck)；
 * · adopted（无 dia.json）→ n/a (adopted)。
 */
export function healthView(
  opts: { record?: HealthRecord | null; hasHealthcheck: boolean; adopted?: boolean; hc?: ServiceHealthcheck; now: number },
): HealthView {
  if (opts.adopted) return { health: "n/a", note: "adopted", stale: false, checked_at: null, age: null, label: "n/a (adopted)" };
  if (!opts.hasHealthcheck) return { health: "n/a", note: "no healthcheck", stale: false, checked_at: null, age: null, label: "n/a (no healthcheck)" };
  const r = opts.record;
  if (!r) return { health: UNKNOWN, note: "never", stale: false, checked_at: null, age: null, label: "unknown (never)" };
  const age = Math.max(0, opts.now - r.ts);
  const window = staleAfter(opts.hc);
  if (age > window) {
    return { health: UNKNOWN, note: "stale", stale: true, checked_at: r.ts, age, label: `unknown (stale ${formatAge(age)})` };
  }
  return { health: r.state, note: "", stale: false, checked_at: r.ts, age, label: `${r.state} (${formatAge(age)} ago)` };
}

// ── 清单：失效项直接生效（不允许装半套）──────────────────────────────────────

/** 清单级校验：失败即 E_MANIFEST（add 在任何写盘之前先调用一次）。 */
export function assertHealthcheckSupported(hc?: ServiceHealthcheck): void {
  if (hc?.interval !== undefined && hc.interval < MIN_HEALTH_INTERVAL) {
    throw new Error(`E_MANIFEST: healthcheck.interval 须 ≥${MIN_HEALTH_INTERVAL}s（收到 ${hc.interval}）`);
  }
  if (hc) {
    const codes = healthCodes(hc);
    for (const n of [...codes.ok, ...codes.degraded, ...codes.fail]) {
      if (n === 124) throw new Error("E_MANIFEST: healthcheck 码表不得包含 124（timeout 由 wrapper 预留）");
    }
  }
}

/** 健康检查任务的周期（§4.2 默认 1800s），独立校验（E_BACKEND）。 */
export function healthJobInterval(svc: ServiceManifest): number {
  const iv = healthInterval(svc.healthcheck);
  const why = checkCronInterval(iv);
  if (why) throw new Error(`E_BACKEND: healthcheck.interval: ${why}`);
  return iv;
}

export type Backend = "launchd" | "cron" | "systemd" | "none";

/**
 * 调度后端（§4.2 / §7）：显式 DIA_SERVICE_BACKEND 优先，否则按平台推断（读不到就不推断）。
 * 推断不出 → E_BACKEND，不静默装半套。
 */
export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const explicit = env.DIA_SERVICE_BACKEND;
  if (explicit === "launchd" || explicit === "cron" || explicit === "systemd" || explicit === "none") return explicit;
  if (explicit) throw new Error(`E_BACKEND: 未知的 DIA_SERVICE_BACKEND=${explicit}（launchd|cron|systemd|none）`);
  if (/^darwin/i.test(process.platform)) return env.DIA_JOB_BIN || env.DIA_SERVICE_JOB_BIN ? "launchd" : "none";
  if (env.DIA_JOB_CRONTAB_BIN || env.DIA_SERVICE_JOB_BIN || env.DIA_JOB_BIN) {
    let cron = false, systemd = false;
    try { cron = !!spawnSync("bash", ["-c", "command -v crontab"], { encoding: "utf8" }).stdout?.trim(); } catch {}
    try { systemd = !!spawnSync("bash", ["-c", "command -v systemctl"], { encoding: "utf8" }).stdout?.trim(); } catch {}
    if (systemd && !cron) return "systemd";
    if (cron) return "cron";
    if (systemd) return "systemd";
  }
  throw new Error("E_BACKEND: 本机没有可用的调度后端（launchd / cron / systemd --user）——不静默装半套；"
    + "测试或自定义后端可用 DIA_SERVICE_BACKEND=none");
}

/** lifecycle.interval 能否被 pkg job 的 cron 后端表达（与 packages/job cron_spec 同口径）。 */
export function cronSpecFor(interval: number): string | null {
  const why = checkCronInterval(interval);
  if (why) return null;
  const mins = Math.floor(interval / 60);
  if (mins < 60) return `*/${mins} * * * *`;
  const hrs = mins / 60;
  if (!Number.isInteger(hrs) || hrs > 23 || 24 % hrs !== 0) return null;
  return `0 */${hrs} * * *`;
}

/** 服务任务外壳（只含稳定入口；契约在台账/env 里，dia 不解读）。 */
export function serviceShell(entryPath: string): string {
  return `'${entryPath.replace(/'/g, `'\\''`)}'`;
}

/**
 * 健康检查任务外壳（§4.2 / §4.1 / §4.3）：
 *   1. 超时包裹：`timeout <s>` / mac 的 `gtimeout`；都没有 → timeout(1) 语义 exit 124（**绝不让判据躺在超时里**）；
 *   2. cwd = 服务安装目录；PATH 继承 DIA_JOB_CRON_PATH；
 *   3. 码映射：只有 health 专用码域 0/20/21 原样透传；contract 的 2=retry 等一律折叠成 1（= 判据不可用）；
 *   4. 去抖：**本 wrapper 是唯一写入方**——调 `dia service health --from-wrapper` 推进状态机并落台账，
 *      dia 退出码随便丢（job 的 verdict 不参与 health 判定），台账里已有已决定状态。
 */
export function healthShell(svc: ServiceManifest, opts: { entryPath: string; dir: string; gen?: string }): string {
  const hc = svc.healthcheck!;
  const timeout = hc.timeout ?? DEFAULT_HEALTH_TIMEOUT;
  const iv = healthJobInterval(svc);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const codes = healthCodes(hc);
  const pass = [...new Set([...codes.ok, ...codes.degraded, ...codes.fail, 124])].join(" ");
  const to = timeout * 1000;
  return [
    `export DIA_SERVICE_HEALTH_FILE=$DIA_JOB_ROOT/tasks/svc-${svc.id}-health.state.jsonl`,
    `export DIA_JOB_CRON_PATH="\${DIA_JOB_CRON_PATH:-$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"`,
    `cd ${q(opts.dir)} || exit 1`,
    `__t=""`,
    `if command -v timeout >/dev/null 2>&1; then __t=timeout; elif command -v gtimeout >/dev/null 2>&1; then __t=gtimeout; fi`,
    `__tf="$(mktemp 2>/dev/null || echo /tmp/dia-hc-$$)"`,
    `if [ -n "$__t" ]; then PATH="$DIA_JOB_CRON_PATH" "$__t" ${timeout} bash -c ${q(hc.cmd)}; else ` +
      `__hb="$(command -v bash)" || __hb=/bin/bash; ` +
      `PATH="$DIA_JOB_CRON_PATH" "$__hb" -c ${q(`"$0" -c "$1" & __p=$!; ( sleep ${timeout}; printf 1 > "$2"; kill -9 $__p 2>/dev/null ) >/dev/null 2>&1 & __w=$!; wait $__p; __rc=$?; kill $__w 2>/dev/null; [ -s "$2" ] && __rc=124; exit $__rc`)} "$__hb" ${q(hc.cmd)} "$__tf"; fi`,
    `__rc=$?`,
    `rm -f "$__tf" 2>/dev/null`,
    `case " ${pass} " in *" $__rc "*) ;; *) echo "healthcheck exit=$__rc 不在 health 码域（0/20/21），判据不可用" >&2; __rc=1;; esac`,
    `DIA_SERVICE_HEALTH_FILE="$DIA_SERVICE_HEALTH_FILE" exec ${diaCmd()} service health --from-wrapper --exit "$__rc" ${opts.gen ? `--gen ${q(opts.gen)} ` : ""}${q(svc.id)} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/**
 * wrapper 里调 dia 的方式：`dia` 在 PATH 上 → 直接用（安装后的正常形态）；
 * 否则（npm dist / 测试内嵌）→ 用 `process.execPath` + 当前 CLI 入口，**不在运行时硬依赖 PATH 上的 dia**。
 */
function diaCmd(): string {
  // 注意：entry 不放进单引号——`'dia'` 会被 shell 当成字面命令名（PATH 查找失效）
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const onPath = spawnSync("bash", ["-c", "command -v dia"], { encoding: "utf8" }).stdout?.trim();
  if (onPath) return "dia";
  const entries = [
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "index.ts"), // src/service.ts → packages/cli
    resolve(dirname(process.argv[1] ?? ""), "..", "src", "cli.ts"),                             // <repo>/src/cli.ts
    resolve(dirname(process.argv[1] ?? ""), "..", "dist", "cli.js"),                            // <install>/dist/cli.js
  ];
  const entry = entries.find((p) => existsSync(p));
  return entry ? `${q(process.execPath)} ${q(entry)}` : "dia";
}

/**
 * 给 `dia job status` 的文本追加 health 行（**纯函数**，零执行）：
 *   · 只在含 `local.dia-job-svc-<id>`（或 `svc-<id>`）标签的行后追加一行；
 *   · 其它行原样输出 → 向后兼容（不改既有格式）。
 */
export function decorateStatus(text: string, view: (id: string) => { label: string }): string {
  const lines = String(text ?? "").split("\n");
  const outLines: string[] = [];
  for (const line of lines) {
    outLines.push(line);
    const m = line.match(/local\.dia-job-svc-([A-Za-z0-9._-]+)/) || line.match(/(?:^|\s)svc-([A-Za-z0-9._-]+)\s/);
    if (!m) continue;
    try {
      const v = view(m[1]);
      if (v?.label) outLines.push(`      health=${v.label}`);
    } catch {
      /* 读缓存失败不拖垮 status */
    }
  }
  return outLines.join("\n");
}

// ── 安装状态（数据根：<diaHome>/services）────────────────────────────────────

export function servicesRoot(): string { return process.env.DIA_SERVICE_HOME || join(paths.diaHome(), "services"); }
export const serviceDir = (id: string) => join(servicesRoot(), id);
export const serviceLockPath = (id: string) => join(serviceDir(id), "service.lock.json");
/** 结果台账 = job 台账（§4.5 不新增文件）：`tasks/svc-<id>-health.state.jsonl` */
export const healthStatePath = (id: string) => process.env.DIA_SERVICE_HEALTH_FILE || join(jobRoot(), "tasks", `${healthJobName(id)}.state.jsonl`);

export interface ServiceLock {
  schema: 1;
  kind: "service";
  id: string;
  version: string;
  dir: string;
  /** 代际 id：每次 add / 重装都变（旧代际行不参与去抖） */
  gen: string;
  added_at: string;
  entry: { declared: string; kind: EntryKind; path: string; link: string | null };
  jobs: { service: string; health: string | null };
  /** 受管文件（相对 dir）：dia.json + healthcheck.cmd 里引用的仓内文件 */
  files: Record<string, string>;
}

export function readLockFile(id: string): ServiceLock {
  if (!existsSync(serviceDir(id))) throw new Error(`E_NOT_INSTALLED: service ${id}`);
  const p = serviceLockPath(id);
  if (!existsSync(p)) throw new Error(`E_NOT_INSTALLED: service ${id}（缺 lock）`);
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error(`E_DRIFT: service.lock.json 不可解析（${p}）`); }
}

export function lockGenerations(): Map<string, ServiceLock> {
  const out = new Map<string, ServiceLock>();
  const root = servicesRoot();
  if (!existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try { out.set(e.name, readLockFile(e.name)); } catch { /* 半装/坏 lock 不挡 list */ }
  }
  return out;
}

/**
 * 代际 id：由 (id, added_at, random) 决定，**每次 add 必变**。
 * 为什么不用时间戳：同一毫秒内 add两次（测试里很常见）会得到同 gen，旧行继续参与计数。
 */
export function newGeneration(id: string, now: Date = new Date()): string {
  return "g-" + createHash("sha256").update(`${id}\0${now.toISOString()}\0${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 8);
}

/** 代际读取：lock 优先；lock 缺失/损坏 → 进程序列兜底（保证每次调用不同、绝不把旧行错算进来）。 */
let ephemeralGen = 0;
export function generationOf(id: string): string {
  try { const g = readLockFile(id).gen; if (typeof g === "string" && g) return g; } catch {}
  return `g-sess${(++ephemeralGen).toString(16).padStart(4, "0")}`;
}

/**
 * 读台账里的全部 health 行（坏行跳过；文件不存在 → 空）。
 * 末尾半写行（追加写被进程杀死打断）= 没有换行；若前缀里已有完整 state，则按该 state 救回一条，
 * 避免「最后一结果恰好是被打断的那次」时被误读成 unknown (never)。
 * 注意：救回行的 `service`/`gen` 也从前缀取（取不到就是空串 → 只能参与「无 lock 兜底」口径），
 * 所以**有 lock** 的读取方在 gen 对不上时必须退化到「ts 最新」（见 readServiceHealth），不能就此报 never。
 */
export function readHealthLines(file: string): HealthRecord[] {
  if (!existsSync(file)) return [];
  const rows: HealthRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (isRecord(d)) rows.push(d as HealthRecord); continue; } catch { /* 坏行/半写行 */ }
    const head = parseStateLine(line);
    const state = head ? /"state"\s*:\s*"(ok|degraded|fail)"/.exec(line)?.[1] : undefined;
    if (head && state) {
      rows.push({
        ...head, state, service: "", gen: "", source: "schedule", candidate: state, streak: 0, raw: state,
        exit: null, timeout: false, detail: "",
      } as HealthRecord);
    }
  }
  return rows;
}

export function appendHealthRecord(file: string, rec: HealthRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n");
}

/**
 * 按「服务的安装形态」推 health 标签——`dia job status` 的 health 列（§4.6 / §6），**只读缓存**：
 *   · `<servicesRoot>/<id>/` 有 dia.json + service.lock.json（lock.gen 与 manifest 都对）→ 用 gen 读台账；
 *   · lock 的 gen 在台账里找不到（坏行 / 半写救回 / 手改 gen）→ 退化为「同服务 ts 最新的一条」；
 *   · 有 dia.json（无 lock，lock 丢失）→ 同上：取 ts 最新的一条；
 *   · 无 dia.json（未迁移 / 未安装）→ adopted → `n/a (adopted)`（没有判据，不报 never）；
 *   · 有 dia.json 但没有 healthcheck → `n/a (no healthcheck)`；
 *   · 台账里没有**已决定状态**（state∉{ok,degraded,fail} 的行、半写/坏行一律跳过）→ `unknown (never)`。
 * 安装根 = `opts.servicesRoot` > `DIA_SERVICE_HOME` > `<jobRoot>/services`（与 listServices 同一口径）。
 * 台账路径 = `opts.healthFile` > `DIA_SERVICE_HEALTH_FILE` > `<jobRoot>/tasks/svc-<id>-health.state.jsonl`（与 healthStatePath 同一口径）。
 * 零执行、零网络 IO；不读 job registry / 不碰调度后端（status 的调度列另算）。
 */
export function readServiceHealth(
  id: string,
  opts: { jobRoot?: string; servicesRoot?: string; now?: number; healthFile?: string } = {},
): HealthView {
  const { healthFile } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const jr = opts.jobRoot ?? jobRoot();
  // 安装根口径：显式参数 > DIA_SERVICE_HOME（servicesRoot()）> <jobRoot>/services；
  // 不能只认 <jobRoot>/services —— DIA_SERVICE_HOME 与 DIA_JOB_ROOT 本来是两个开关。
  const dir = opts.servicesRoot ?? (process.env.DIA_SERVICE_HOME || join(jr, "services"));
  const installDir = join(dir, id);
  let lock: ServiceLock | null = null;
  try { lock = readLockFile(id); } catch { /* 未装/半装：退化为 manifest 口径 */ }
  let svc: ServiceManifest | null = null;
  try { svc = readServiceManifest(lock?.dir ?? installDir); } catch { /* 无 dia.json / 坏清单 */ }
  // 无 dia.json = 尚未迁移（adopted，§7）：有 lock 也按 job 侧口径报 adopted —— 没有清单就没有判据，
  // 此时台账里即便有行也只能是旧行，读成 never / 旧状态反而更误导。
  if (!svc) return healthView({ adopted: true, hasHealthcheck: false, now });
  const hc = svc?.healthcheck;
  if (!hc) return healthView({ hasHealthcheck: false, now });
  // 半写行救回时不带 service/gen（空串）→ 只能参与下面的「ts 最新」兜底，不串到别的服务
  // 台账路径口径与 healthStatePath 一致：显式 healthFile > DIA_SERVICE_HEALTH_FILE > <jobRoot>/tasks/<job>.state.jsonl
  const ledger = healthFile ?? healthStatePath(id);
  const recs = readHealthLines(ledger).filter(isRecord);
  // 有 lock 但 gen 对不上（台账行的时间戳坏掉 / 手改过 gen / 半写行救回时丢了三段式 gen）
  // → 退化到「ts 最新」，不让一个异常 lock 把新鲜的结果读成 unknown (never)
  let rec = lock ? findLastHealth(recs, id, lock.gen) : null;
  if (!rec) {
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      if (r.state !== "ok" && r.state !== "degraded" && r.state !== "fail") continue;
      if (r.service && r.service !== id) continue;
      if (!rec || r.ts > rec.ts) rec = r;
    }
  }
  return healthView({ record: rec, hasHealthcheck: true, hc, now });
}

// ── 读取（只读缓存：零执行 / 零网络 IO）────────────────────────────────────────

export interface ServiceRow {
  id: string;
  version: string | null;
  dir: string | null;
  adopted: boolean;
  gen: string | null;
  target: string | null;
  /** target 与本机一致？（比对口径：去 .local + 小写） */
  on_this_host: boolean;
  lifecycle: { type: string; interval?: number } | null;
  jobs: { service: string; health: string | null };
  health: HealthState | "n/a";
  /** true = 已过期（不再显示旧状态） */
  stale: boolean;
  checked_at: number | null;
  /** 展示串（ok (5m ago) / unknown (stale 47m) / n/a (adopted) …） */
  label: string;
  note: HealthView["note"];
  last_error: string | null;
  problem?: string;
}

export interface ListOptions {
  servicesRoot?: string;
  jobRoot?: string;
  registry?: string | null;
  now?: number;
  hostname?: string;
}

/** `dia service list`：lock 里受管的 + adopted（README 契约、无 dia.json）只读可见。 */
export function listServices(opts: ListOptions = {}): ServiceRow[] {
  const root = opts.servicesRoot ?? servicesRoot();
  const jr = opts.jobRoot ?? jobRoot();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const host = normalizeHost(opts.hostname ?? osHostname());
  const reg = opts.registry === null ? null : readRegistryTasks(opts.registry ?? registryPath());
  const rows: ServiceRow[] = [];
  const seen = new Set<string>();

  if (existsSync(root)) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      seen.add(e.name);
      rows.push(rowFor(e.name, { root, jr, now, host, reg }));
    }
  }
  // adopted：只有 README 契约、没有 dia.json 的历史服务 → 不在 services/ 下，列出来让人看到「还没迁移」
  const adoptRoot = join(root, "adopted");
  if (existsSync(adoptRoot)) {
    for (const e of readdirSync(adoptRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      rows.push({
        id: e.name, version: null, dir: join(adoptRoot, e.name), adopted: true, gen: null, target: null, on_this_host: true,
        lifecycle: null, jobs: { service: serviceJobName(e.name), health: null },
        health: "n/a", stale: false, checked_at: null, label: "n/a (adopted)", note: "adopted", last_error: null,
      });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function rowFor(id: string, ctx: { root: string; jr: string; now: number; host: string; reg: Set<string> | null }): ServiceRow {
  const dir = join(ctx.root, id);
  const row: ServiceRow = {
    id, version: null, dir, adopted: false, gen: null, target: null, on_this_host: true, lifecycle: null,
    jobs: { service: serviceJobName(id), health: null },
    health: UNKNOWN, stale: false, checked_at: null, label: "unknown (never)", note: "never", last_error: null,
  };
  let lock: ServiceLock | null = null;
  try { lock = readLockFile(id); } catch (e: any) { row.problem = e?.message || String(e); }
  let svc: ServiceManifest | null = null;
  try { svc = readServiceManifest(dir); } catch (e: any) { row.problem ??= e?.message || String(e); }

  if (lock) {
    row.version = lock.version; row.gen = lock.gen; row.jobs = lock.jobs;
    row.dir = lock.dir;
  } else if (svc) { row.version = svc.version; row.jobs = { service: serviceJobName(id), health: svc.healthcheck ? healthJobName(id) : null }; }
  if (svc) {
    row.target = svc.lifecycle.target ?? null;
    row.on_this_host = !row.target || normalizeHost(row.target) === ctx.host;
    row.lifecycle = { type: svc.lifecycle.type, interval: svc.lifecycle.interval };
  }
  // adopted（README 契约、无 dia.json、无 lock）
  if (!lock && !svc) { row.adopted = true; row.dir = join(ctx.root, id); }
  if (row.adopted) {
    Object.assign(row, { health: "n/a", stale: false, checked_at: null, label: "n/a (adopted)", note: "adopted" });
    return row;
  }
  // 只读缓存：取本代际最近一条已决定状态（绝不重算 candidate/streak）
  const rec = lock && svc ? findLastHealth(readHealthLines(healthStatePath(id)), id, lock.gen) : null;
  const view = healthView({ record: rec, hasHealthcheck: !!svc?.healthcheck, hc: svc?.healthcheck, now: ctx.now });
  Object.assign(row, { health: view.health, stale: view.stale, checked_at: view.checked_at, label: view.label, note: view.note, last_error: rec?.last_error ?? null });
  if (ctx.reg && !ctx.reg.has(row.jobs.service)) row.problem = `job registry 缺少服务任务 ${row.jobs.service}`;
  return row;
}

/** `dia service show <id>`：list 的一行 + 入口 + 最近结果明细。 */
export function showService(id: string, opts: ListOptions = {}): (ServiceRow & { lock: ServiceLock | null; last: HealthRecord | null }) | null {
  const row = listServices(opts).find((r) => r.id === id);
  if (!row) return null;
  let lock: ServiceLock | null = null;
  try { lock = readLockFile(id); } catch {}
  const last = lock ? findLastHealth(readHealthLines(healthStatePath(id)), id, lock.gen) : null;
  return { ...row, lock, last };
}

/** 把子进程结果判成健康结论（供 runHealth 与单测复用）。 */
export function judgeSpawnResult(r: {
  status?: number | null;
  signal?: string | number | null;
  stderr?: string | Buffer | null;
  error?: any;
  killed?: boolean;
}): HealthJudgement {
  if (r.error) {
    const code = (r.error as any).code;
    return { state: "crash", exit: null, timeout: false, detail: code ? `${code}: ${r.error.message}` : String(r.error.message || r.error), inDomain: false };
  }
  if (r.killed && (r.signal ?? null) === null) return judgeHealth(124, {});
  return judgeHealth(r.status ?? null, { signal: r.signal ?? null });
}

export interface HealthRun {
  judgement: HealthJudgement;
  /** 可选结构化输出 `{ status, checks }`；不可解析时 crash */
  report?: { status: string; checks?: unknown[] };
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * 实时执行一次 healthcheck（§5 `dia service health`）。
 * cwd = 服务安装目录（与 entry 相对路径同一基准，C2）。
 * 超时：优先 `timeout(1)`（macOS 用 `gtimeout`）；没有则 fallback 到 spawn 的 timeout——
 * 同一进程组里被 SIGKILL 的只有 healthcheck 子进程，**不杀 dia、也不杀服务本身**。
 * stdout 有 JSON 但不可解析 → crash（不冒充 ok/fail）。不据 checks 自行升降级。
 */
export function runHealth(
  svc: ServiceManifest,
  opts: { dir: string; env?: NodeJS.ProcessEnv; now?: () => number; cwd?: string },
): HealthRun {
  const hc = svc.healthcheck;
  if (!hc) throw new Error("E_NO_HEALTHCHECK: 清单未声明 healthcheck");
  const timeoutSec = hc.timeout ?? 60;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const env = { ...process.env, ...(opts.env ?? {}) };

  const t = whichTimeout1();
  const [cmd, args] = t
    ? [t, [String(timeoutSec), "bash", "-c", hc.cmd]]
    : ["bash", ["-c", hc.cmd]];

  const r = spawnSync(cmd, args, {
    cwd: opts.dir,
    env,
    encoding: "utf8",
    timeout: t ? undefined : timeoutSec * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  const ms = now() - t0;
  const stdout = String(r.stdout ?? "");
  const stderr = String(r.stderr ?? "");
  // 兜底超时（无 timeout(1)）：spawnSync 用 SIGKILL 杀子进程，必须翻译成 124 语义，
  // 否则会被 judgeSpawnResult 当成 crash（macOS 无 gtimeout 的 CI 上就是这样假红）。
  const timedOut =
    !t &&
    ((r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") ||
      (r.signal === "SIGKILL" && ms >= timeoutSec * 1000 - 100));
  let judgement = timedOut
    ? judgeSpawnResult({ status: 124 })
    : judgeSpawnResult({ status: r.status, signal: r.signal, error: r.error, killed: r.error == null && r.status == null });

  // 结构化输出（可选，§4.1）：`{` 开头却解析不了 → crash（不冒充 ok/fail）。
  // 兜底超时（无 timeout(1) 时 spawn 自身 timeout）SIGKILL 的子进程同样是「超时」，归 124 语义；
  // 先判超时再判 JSON，避免子进程被杀的残片输出掩盖「timeout」。
  let report: HealthRun["report"];
  const trimmed = stdout.trim();
  let unparseable = false;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as HealthRun["report"];
    } catch {
      unparseable = true;
    }
  }
  if (judgement.state === "degraded" && judgement.timeout) {
    unparseable = false; // timeout 明细优先，不再被输出残片覆盖
  } else if (unparseable) {
    judgement = { ...judgement, state: "crash", detail: "stdout json unparseable", inDomain: false };
  }
  if (judgement.state === "crash" && judgement.detail.startsWith("no exit status") && stderr.trim()) {
    judgement = { ...judgement, detail: stderr.trim().split("\n")[0] };
  }
  return { judgement, report, stdout, stderr, ms };
}

// ── agent 型健康检查（§14.3）─────────────────────────────────────────────────

export interface AcpCheck { step: "initialize" | "session/new"; state: HealthRaw; detail: string }

export interface AcpHealthRun {
  judgement: HealthJudgement;
  report: { status: HealthRaw; checks: { name: string; status: string; detail: string }[] };
  ms: number;
  steps: AcpCheck[];
}

/**
 * 用 ACP 判活（§14.3）：`initialize` 能应答 = 端点活着；`session/new` 成功 = 能开工。
 *   连不上/超时 → degraded（infra 抖动）；initialize 报错 → degraded（配置面）；
 *   session/new 报错 → fail（鉴权/配置问题，不是抖动）。
 * **绝不判断回答质量、不重放业务 prompt**。
 */
export async function runAcpHealth(
  svc: ServiceManifest,
  opts: { dir: string; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<AcpHealthRun> {
  const hc = svc.healthcheck;
  if (!hc || healthcheckKind(hc) !== "acp") throw new Error("E_MANIFEST: runAcpHealth 只处理 healthcheck.kind=acp");
  const agent = svc.entry.agent;
  if (!agent) throw new Error("E_MANIFEST: healthcheck.kind=acp 需要 entry.agent");
  const timeoutMs = (hc.timeout ?? DEFAULT_HEALTH_TIMEOUT) * 1000;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const argv = acpAgentCommand(agent);
  const env = { ...process.env, ...(opts.env ?? {}) };
  const steps: AcpCheck[] = [];

  const finish = (status: HealthRaw, exit: number): AcpHealthRun => {
    const judgement: HealthJudgement = { ...judgeHealth(exit, {}), state: status, exit, timeout: false,
      detail: steps.filter((x) => x.state !== "ok").map((x) => `${x.step}: ${x.detail}`).join("; ")
        || `initialize + session/new ok（${agent.host}${agent.profile ? " --profile " + agent.profile : ""}）` };
    return { judgement, report: { status, checks: steps.map((x) => ({ name: x.step, status: x.state, detail: x.detail })) }, ms: now() - t0, steps };
  };

  const child = spawn(argv[0], argv.slice(1), { cwd: opts.dir, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (m: any) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = msg && msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });
  const spawnError = await new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    child.once("error", (e: any) => done(String(e?.message || e)));
    child.once("spawn", () => done(null));
    setTimeout(() => done(null), 50);
  });
  if (spawnError) return (steps.push({ step: "initialize", state: "degraded", detail: `端点起不来：${spawnError}` }), finish("degraded", 20));

  const call = (id: number, method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
      catch (e: any) { clearTimeout(timer); pending.delete(id); resolve({ died: String(e?.message || e) }); }
    });

  try {
    const init = await call(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (init.timeout) steps.push({ step: "initialize", state: "degraded", detail: "initialize 超时" });
    else if (init.died) steps.push({ step: "initialize", state: "degraded", detail: `端点已退出：${init.died}` });
    else if (init.error) steps.push({ step: "initialize", state: "degraded", detail: `initialize 报错：${init.error?.message ?? JSON.stringify(init.error)}` });
    else if (!init.result) steps.push({ step: "initialize", state: "degraded", detail: "initialize 无 result" });
    else steps.push({ step: "initialize", state: "ok", detail: "initialize ok" });
    if (steps[0].state !== "ok") return finish("degraded", 20);

    const ns = await call(2, "session/new", { cwd: opts.dir, mcpServers: [] });
    if (ns.timeout) steps.push({ step: "session/new", state: "fail", detail: "session/new 超时" });
    else if (ns.error) steps.push({ step: "session/new", state: "fail", detail: `session/new 报错：${ns.error?.message ?? JSON.stringify(ns.error)}` });
    else if (!ns.result?.sessionId) steps.push({ step: "session/new", state: "fail", detail: "session/new 未返回 sessionId" });
    else steps.push({ step: "session/new", state: "ok", detail: `session ${ns.result.sessionId}` });
    return steps[1].state === "ok" ? finish("ok", 0) : finish("fail", 21);
  } finally {
    try { child.kill("SIGKILL"); } catch { /* noop */ }
  }
}

/** 把一次 judgement 记进台账（唯一写入方口径：`transition` + 追加）。 */
export function recordHealth(
  svc: ServiceManifest,
  judgement: HealthJudgement,
  opts: { gen?: string; stateFile?: string; now?: number; source?: "schedule" | "manual"; checks?: unknown[] } = {},
): { record: HealthRecord; statePath: string } {
  const id = svc.id;
  const gen = opts.gen || generationOf(id);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const file = opts.stateFile || process.env.DIA_SERVICE_HEALTH_FILE || healthStatePath(id);
  const record = transition(findLastHealth(readHealthLines(file), id, gen), {
    service: id, gen, source: opts.source ?? "manual", ts: now, judgement,
    debounce: svc.healthcheck?.debounce, checks: opts.checks as any,
  });
  appendHealthRecord(file, record);
  return { record, statePath: file };
}

/** 找 `timeout(1)` / mac 的 `gtimeout`；都没有返回 null（走 spawn 的 timeout）。 */
export function whichTimeout1(): string | null {
  const probe = spawnSync("bash", ["-c", "command -v timeout || command -v gtimeout"], { encoding: "utf8" });
  const p = String(probe.stdout ?? "").trim().split("\n")[0];
  return p || null;
}

// ── verify ───────────────────────────────────────────────────────────────────

export type DriftCode =
  | "entry_missing"
  | "entry_not_executable"
  | "entry_link_drift"
  | "lock_drift"
  | "job_missing"
  | "health_job_missing";

export interface Drift { code: DriftCode; detail: string }

export interface VerifyResult {
  id: string;
  dir: string;
  ok: boolean;
  entry: { kind: EntryKind; path: string };
  drift: Drift[];
}

/** 服务任务 / 健康检查任务在 job registry 中的名字（§4.2：`svc-<id>-health`）。 */
export const serviceJobName = (id: string) => `svc-${id}`;
export const healthJobName = (id: string) => `svc-${id}-health`;

/** 读 registry 的任务名集合；registry 不存在或不可解析 → null（尚未安装 job 后端，不是漂移）。 */
export function readRegistryTasks(file = registryPath()): Set<string> | null {
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Object.keys(d?.tasks ?? {}));
  } catch { return null; }
}

const RUNTIME_NOISE = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);
export const isRuntimeNoise = (p: string) => p.split(/[\\/]/).some((seg) => RUNTIME_NOISE.has(seg));

/** lock 的 files 哈希（复用 persona lock 口径：相对路径 + \0 + 内容 sha256，按序拼进一个 sha256）。 */
export function hashFiles(base: string, files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const rel of Object.keys(files).sort()) h.update(rel).update("\0").update(files[rel]).update("\n");
  return h.digest("hex");
}

/**
 * 受管文件：dia.json + healthcheck.cmd 里引用的**仓内相对路径**（形如 `bin/healthcheck`、`./scripts/h.sh`）。
 * 只认「相对 base 存在且是文件」的 token（`--json` / `-h` 之类选项自然落空），运行期产物目录跳过。
 */
export function collectManagedFiles(base: string, hc?: ServiceHealthcheck): Record<string, string> {
  const out: Record<string, string> = {};
  const rel = "dia.json";
  const p = join(base, rel);
  if (existsSync(p)) out[rel] = shaFile(p);
  if (!hc) return out;
  for (const token of hc.cmd.split(/\s+/)) {
    const t = token.replace(/^["']|["']$/g, "");
    if (!t || t.startsWith("-") || isAbsolute(t)) continue;
    if (t.includes("$") || t.includes("=") || t.includes("|") || t.includes(">") || t.includes("<")) continue;
    const abs = resolve(base, t);
    if (relative(base, abs).startsWith("..") || isRuntimeNoise(t)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    out[relative(base, abs)] = shaFile(abs);
  }
  return out;
}

export interface JobRunner {
  (args: string[]): { status: number | null; stdout: string; stderr: string };
}

/**
 * `dia service verify`（§5）：
 * · 清单（§3）→ E_MANIFEST / E_NO_MANIFEST；
 * · entry 存在 / 可执行 / 仓内或 ref-entry → E_UNSTABLE_ENTRY（resolveEntry 抛出）；
 * · lock（C4）：ref-entry 软链目标仍是安装目录（切换了 checkout → entry_link_drift）；
 *   受管文件 sha256 与 lock 不一致 → lock_drift；
 * · job registry 含服务任务与健康检查任务 → job_missing / health_job_missing。
 */
export function verify(dir: string, opts: { registry?: string | null; lock?: ServiceLock | null } = {}): VerifyResult {
  const svc = readServiceManifest(dir);
  const entry = resolveEntry(entryCmdOf(svc), dir);
  const drift: Drift[] = [];

  if (!existsSync(entry.path)) drift.push({ code: "entry_missing", detail: `entry 不存在：${entry.path}` });
  else if (!isExecutableFile(entry.path)) drift.push({ code: "entry_not_executable", detail: `entry 不可执行：${entry.path}` });

  const lock = opts.lock === undefined ? (existsSync(serviceDir(svc.id)) ? tryLock(svc.id) : null) : opts.lock;
  if (lock) {
    if (entry.kind === "ref") {
      const want = lock.entry.link ? resolve(lock.entry.link) : null;
      if (!want) drift.push({ code: "entry_link_drift", detail: `lock 未记录稳定入口链接：${lock.entry.path}` });
      else if (isSymlink(lock.entry.path) && resolve(readlinkSync(lock.entry.path)) !== want) {
        drift.push({ code: "entry_link_drift", detail: `稳定入口链接已改指向（${readlinkSync(lock.entry.path)} ≠ ${want}）` });
      }
    } else if (lock.entry.path && resolve(lock.entry.path) !== entry.path) {
      drift.push({ code: "entry_link_drift", detail: `lock 记录的入口 ${lock.entry.path} 与清单解析出的 ${entry.path} 不一致` });
    }
    const now = collectManagedFiles(lock.dir || dir, svc.healthcheck);
    const actual = hashFiles(lock.dir || dir, now);
    if (actual !== hashFiles(lock.dir || dir, lock.files)) {
      const changed = [...new Set([...Object.keys(now), ...Object.keys(lock.files)])]
        .filter((k) => now[k] !== lock.files[k]);
      drift.push({ code: "lock_drift", detail: `受管文件与 lock 不一致：${changed.join(", ")}` });
    }
  }

  const reg = opts.registry === null ? null : readRegistryTasks(opts.registry ?? registryPath());
  if (reg) {
    const job = serviceJobName(svc.id);
    if (!reg.has(job)) drift.push({ code: "job_missing", detail: `job registry 缺少服务任务 ${job}` });
    const hj = healthJobName(svc.id);
    if (svc.healthcheck && !reg.has(hj)) drift.push({ code: "health_job_missing", detail: `job registry 缺少健康检查任务 ${hj}` });
  }

  return { id: svc.id, ok: drift.length === 0, entry: { kind: entry.kind, path: entry.path }, drift };
}

function tryLock(id: string): ServiceLock | null {
  try { return readLockFile(id); } catch { return null; }
}

// ── add / remove（调度落地交给 job；本模块不新增调度器）─────────────────────────

export interface AddOptions {
  dir: string;
  /** 来源（git URL / 本地目录）；缺省 = dir 本身 */
  from?: string;
  ref?: string;
  dryRun?: boolean;
  force?: boolean;
  /** 测试/自定义：注入 job 执行器（默认 `dia job install|uninstall`） */
  runner?: JobRunner;
  backend?: Backend;
  now?: Date;
}

export interface AddResult {
  id: string;
  version: string;
  dir: string;
  gen: string;
  dryRun: boolean;
  backend: Backend;
  entry: ServiceLock["entry"];
  jobs: ServiceLock["jobs"];
  target_mismatch: boolean;
}

/** 能像仓库一样「取回」的本地包：有 dia.json 的普通目录，或 tar 包 / 单文件脚本（视为 adopted 服务）。 */
const looksLikeRepo = (from: string) =>
  existsSync(join(from, "dia.json")) || existsSync(join(from, ".git")) || existsSync(join(from, "package.json"));

function linkEntry(path: string): string {
  const dir = entryDir();
  mkdirSync(dir, { recursive: true });
  const name = basename(path);
  const dest = join(dir, name);
  if (isSymlink(dest)) unlinkSync(dest);
  else if (existsSync(dest)) throw new Error(`E_CONFLICT: 稳定入口 ${dest} 已存在且不是软链`);
  symlinkSync(resolve(path), dest);
  return dest;
}

function defaultRunner(opts: { backfill?: string[] } = {}): JobRunner {
  return (args) => {
    const { bin, error } = jobBin();
    if (!bin) return { status: 2, stdout: "", stderr: `${error || "未找到 dia-job"}\n` };
    const full = [...args];
    const descAt = full.indexOf("--desc");
    for (const line of opts.backfill ?? []) full.splice(descAt >= 0 ? descAt : full.length, 0, ...line.split(" "));
    const r = spawnSync(bin, full, { encoding: "utf8", env: { ...process.env, DIA_JOB_ROOT: jobRoot() } });
    return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  };
}

/**
 * `dia service add`（§5）：
 *   取回 → 清单校验（§3，含码域/interval，**全部在写盘之前**）→ entry 校验（稳定入口）→
 *   转发 `dia job install`（服务任务 + `svc-<id>-health`）→ 写 lock（新 gen）。
 * 任何一步失败都不留半装：已装上的 job 会被撤掉。
 * 调度表达不了 → E_BACKEND，**不写任何调度条目**。
 */
export function add(opts: AddOptions): AddResult {
  const rawDir = resolve(opts.dir);
  let dir = rawDir;
  let copied = false;
  if (opts.from !== undefined) {
    const src = resolve(opts.from);
    if (!existsSync(src)) throw new Error(`E_SOURCE: path not found: ${src}`);
    if (looksLikeRepo(src)) cloneInto(src, rawDir);
    else { copyAdopted(src, rawDir); copied = true; }
    dir = rawDir;
  }

  const svc = readServiceManifest(dir);
  assertHealthcheckSupported(svc.healthcheck);
  // 后端探测：探测失败 / none 时仍允许 --dry-run（只是看一眼装什么，不写任何调度条目）
  let backend: Backend;
  try { backend = opts.backend ?? detectBackend(); } catch (e: any) {
    if (!opts.dryRun) throw e;
    backend = "none";
  }
  if (backend === "none" && !opts.dryRun) throw new Error("E_BACKEND: 本机没有可用的调度后端（launchd / cron / systemd --user）");
  // 调度表达不了 → E_BACKEND（在任何写盘之前；与 cron_spec 的 rc=3 对齐，不静默改间隔）
  if (svc.lifecycle.type === "periodic" && cronSpecFor(svc.lifecycle.interval!) === null) {
    throw new Error(`E_BACKEND: lifecycle.interval=${svc.lifecycle.interval}s 调度后端（${backend}）表达不了；未安装任何调度条目`);
  }
  if (svc.healthcheck) healthJobInterval(svc);

  const entry = resolveEntry(entryCmdOf(svc), dir);
  if (!existsSync(entry.path)) throw new Error(`E_UNSTABLE_ENTRY: entry 不存在：${entry.path}`);
  if (!isExecutableFile(entry.path)) throw new Error(`E_UNSTABLE_ENTRY: entry 不可执行：${entry.path}`);

  const gen = newGeneration(svc.id, opts.now ?? new Date());
  const mismatch = !!svc.lifecycle.target && normalizeHost(svc.lifecycle.target) !== normalizeHost(osHostname());
  const result: AddResult = {
    id: svc.id, version: svc.version, dir, gen, dryRun: !!opts.dryRun, backend,
    entry: { declared: entryCmdOf(svc), kind: entry.kind, path: entry.path, link: null },
    jobs: { service: serviceJobName(svc.id), health: svc.healthcheck ? healthJobName(svc.id) : null },
    target_mismatch: mismatch,
  };
  if (opts.dryRun) {
    if (copied) rmSync(dir, { recursive: true, force: true });
    return result;
  }

  // 重装：先卸旧任务，再装新的（避免同名任务残留旧 cmd/gen）
  // 作业根在 ~/.dia/job 下、命令从 ~/.local/bin 进：不是 git 主 checkout ⇒ 用 job 的逃生舱并写明理由
  const backfill = ["--allow-unstable", "--desc", `dia service ${svc.id}: healthcheck 只读判定，稳定入口 ${entryPathOf(entryCmdOf(svc), dir)}`];
  const runner = opts.runner ?? defaultRunner({ backfill });
  const installed: string[] = [];
  const fail = (code: string, msg: string, rc?: number | null): never => {
    for (const name of installed.reverse()) runner(["uninstall", name]);
    const err = new Error(`${code}: ${msg}${rc === null || rc === undefined ? "" : `（dia job 退出码 ${rc}）`}`);
    (err as any).code = code;
    throw err;
  };
  if (existsSync(serviceLockPath(svc.id))) remove({ id: svc.id, runner });

  // 稳定入口：仓内相对路径 → 链到 DIA_JOB_ENTRY_DIR（ref-entry 已是稳定入口，不动）
  let entryPath = entry.path;
  if (entry.kind === "repo") {
    entryPath = linkEntry(entry.path);
    result.entry.link = entryPath;
    result.entry.path = entryPath;
  } else if (entryCmdOf(svc).startsWith(entryDir())) {
    result.entry.link = entry.path;
  }

  const jobArgs = (name: string, cmd: string): string[] => {
    const a = ["install", name, "--cmd", cmd, "--desc", `dia service ${svc.id}`];
    if (svc.lifecycle.type === "periodic") a.push("--interval", String(svc.lifecycle.interval), "--type", "periodic");
    else a.push("--type", svc.lifecycle.type);
    return a;
  };
  const jr = runner(jobArgs(result.jobs.service, serviceShell(entryPath)));
  if (jr.status !== 0) fail(jr.status === 3 ? "E_BACKEND" : "E_JOB", `服务任务安装失败：${(jr.stderr || jr.stdout).trim().split("\n").pop() || "?"}`, jr.status);
  installed.push(result.jobs.service);
  if (svc.healthcheck && result.jobs.health) {
    const hr = runner(jobArgs(result.jobs.health, healthShell(svc, { entryPath, dir, gen })));
    if (hr.status !== 0) fail(hr.status === 3 ? "E_BACKEND" : "E_JOB", `健康检查任务安装失败：${(hr.stderr || hr.stdout).trim().split("\n").pop() || "?"}`, hr.status);
    installed.push(result.jobs.health);
  }

  const files = collectManagedFiles(dir, svc.healthcheck);
  const lock: ServiceLock = {
    schema: 1, kind: "service", id: svc.id, version: svc.version, dir, gen, added_at: (opts.now ?? new Date()).toISOString(),
    entry: result.entry, jobs: result.jobs, files,
  };
  mkdirSync(serviceDir(svc.id), { recursive: true });
  // 受管副本（与原仓同内容）：job 任务从 ~/.dia/job 运行，绝不能依赖 checkout 路径——清理 checkout 后服务照常
  if (!isInside(serviceDir(svc.id), dir)) {
    const copy = join(serviceDir(svc.id), "repo");
    rmSync(copy, { recursive: true, force: true });
    copyTree(dir, copy);
  }
  writeFileSync(serviceLockPath(svc.id), JSON.stringify(lock, null, 1) + "\n");
  return result;
}

const entryPathOf = (cmd: string, dir: string) => resolveEntry(cmd, dir).path;

/** a 是否在 b 内（含相等）：按路径段判断，`/a/bc` 不算在 `/a/b` 内。 */
export function isInside(a: string, b: string): boolean {
  const rel = relative(resolve(b), resolve(a));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function cloneInto(from: string, to: string): void {
  if (isGitRepo(from)) {
    const r = spawnSync("git", ["clone", "--quiet", from, to], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`E_SOURCE: git clone failed（${(r.stderr || "").trim()}）`);
    return;
  }
  copyTree(from, to);
}

function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, dereference: true, filter: (p: string) => !isRuntimeNoise(relative(from, p)) });
}

/** adopted：普通目录 / tar 包 / 单文件脚本 → 只能「只读可见」（n/a adopted），verify/health 报 E_NO_MANIFEST。 */
function copyAdopted(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`E_CONFLICT: ${to} 已存在`);
  mkdirSync(dirname(to), { recursive: true });
  if (statSync(from).isDirectory()) copyTree(from, to);
  else {
    mkdirSync(to, { recursive: true });
    cpSync(from, join(to, basename(from)));
  }
}

function isGitRepo(p: string): boolean {
  return existsSync(join(p, ".git"));
}

export interface RemoveOptions { id: string; runner?: JobRunner; now?: number }

/** `dia service remove`：job uninstall（服务任务 + 健康检查任务）→ 清台账 → 回收稳定入口链接 → 删 lock。 */
export function remove(opts: RemoveOptions): { id: string; removed: string[]; skipped: string[]; jobs: string[] } {
  const lock = readLockFile(opts.id);
  const runner = opts.runner ?? defaultRunner();
  const removed: string[] = [], skipped: string[] = [];
  const vars = new Set([opts.id, lock.jobs.service, lock.jobs.health].filter(Boolean) as string[]);
  for (const name of vars) {
    const r = runner(["uninstall", name]);
    if (r.status === 5 || /未登记|not found|不存在/i.test(`${r.stderr}${r.stdout}`)) skipped.push(name);
  }
  if (lock.entry.kind === "repo" && lock.entry.link && isSymlink(lock.entry.link)) {
    const rel = readlinkSync(lock.entry.link);
    if (rel.startsWith(lock.dir) || resolve(dirname(lock.entry.link), rel).startsWith(lock.dir)) {
      unlinkSync(lock.entry.link); removed.push(lock.entry.link);
    } else skipped.push(lock.entry.link);
  }
  rmSync(healthStatePath(opts.id), { force: true });
  rmSync(serviceDir(opts.id), { recursive: true, force: true });
  return { id: opts.id, removed, skipped, jobs: [...vars].slice(1) };
}

// ── health（实时执行一次 + 落台账，source=manual）─────────────────────────────

export interface HealthOptions {
  /** `dia service add` 的安装根（默认 <diaHome>/services） */
  servicesRoot?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** 台账落点（默认 <jobRoot>/tasks/svc-<id>-health.state.jsonl） */
  stateFile?: string;
  /** wrapper 已判定过的退出码（`--from-wrapper`）：不再执行，只推进状态机 */
  wrapperExit?: number;
  /** 强制代际（默认读 lock） */
  gen?: string;
}

export interface HealthResult {
  id: string;
  dir: string;
  judgement: HealthJudgement;
  record: HealthRecord;
  state_path: string;
  /** health 子命令退出码（0/30/1/31） */
  exit: number;
  json: Record<string, unknown>;
}

/**
 * `dia service health <id>`（§5）：
 * · 实时执行 healthcheck（cwd = 安装目录），按 §4.1 判定；
 * · **把结果落台账**（`source:"manual"`）——本函数就是这次写入的唯一写入方，去抖在此推进；
 * · 退出码 0 ok · 30 degraded · 1 fail · 31 判据不可用；未知 id / 未声明 healthcheck → 2。
 */
export function runServiceHealth(id: string, opts: HealthOptions = {}): HealthResult {
  const root = opts.servicesRoot ?? servicesRoot();
  const dir = join(root, id);
  if (!existsSync(dir)) throw usageError(`E_NOT_INSTALLED: service ${id}`);
  const svc = readServiceManifest(dir);
  if (!svc.healthcheck) throw usageError(`E_NO_HEALTHCHECK: service ${id} 未声明 healthcheck`);
  const gen = opts.gen || generationOf(id);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // wrapper 显式导出 DIA_SERVICE_HEALTH_FILE（唯一写入方定的落点）；否则用 job 台账默认位置
  const file = opts.stateFile || process.env.DIA_SERVICE_HEALTH_FILE || healthStatePath(id);

  let judgement: HealthJudgement;
  let checks: unknown[] | undefined;
  let ms = 0;
  if (opts.wrapperExit !== undefined) {
    judgement = judgeHealth(opts.wrapperExit, { codes: healthCodes(svc.healthcheck) });
  } else {
    const r = runHealth(svc, { dir, env: opts.env });
    judgement = r.judgement;
    checks = Array.isArray(r.report?.checks) ? r.report.checks : undefined;
    ms = r.ms;
  }
  const record = transition(findLastHealth(readHealthLines(file), id, gen), {
    service: id, gen, source: opts.wrapperExit !== undefined ? "schedule" : "manual", ts: now, judgement,
    debounce: svc.healthcheck.debounce, checks,
  });
  appendHealthRecord(file, record);
  const exit = judgement.state === "crash" ? HEALTH_EXIT.crash : healthExitCode(judgement);
  return {
    id, dir, judgement, record, state_path: file, exit,
    json: {
      id, verdict: judgement.state, shown: record.state, exit: judgement.exit, timeout: judgement.timeout,
      detail: judgement.detail, debounce: { candidate: record.candidate, streak: record.streak }, ms,
      checks, gen, source: record.source, ts: now,
    },
  };
}

function usageError(msg: string): Error {
  const e = new Error(msg);
  (e as any).code = "E_USAGE";
  return e;
}
