// log —— dia 的**人可读运行日志**（分级，走 stderr）
//
// 与 msg-events.ts 的分工（别混）：
//   · msg-events.ts = 机器可读结构化事件流（JSONL，给 `dia msg trace` / stats 消费），append-only、0600
//   · 本模块        = 人可读旁路日志，给「当时到底发生了什么」用，**没有**稳定 schema，不进任何报表
// 所以：状态迁移的**事实**写事件流（trace 需要），细节/上下文/快照写本日志。两处都可以有，
// 但不要为了留痕去改业务返回值、加 await、加分支——留痕永远是旁路。
//
// 口径（2026-11-18 用户拍板）：
//   · 级别：verbose < debug < info < warn < error（显示 >= 阈值的；off = 全关）
//   · 默认 **verbose**（开发主力机默认全开）
//   · 级别来源：`DIA_LOG_LEVEL`（大小写不敏感）；空/非法值 → 回落 verbose
//   · 通道：stderr —— 绝不污染 stdout 的结构化输出（--json 等）
//   · 单条 < 4KB（超长字段截断，与 msg-events 同口径）；写失败静默（不能反过来阻断业务）
import { inspect } from "node:util";

export type Level = "verbose" | "debug" | "info" | "warn" | "error";
export type LevelSetting = Level | "off";

const ORDER: Level[] = ["verbose", "debug", "info", "warn", "error"];
const DEFAULT: LevelSetting = "verbose";
/** 单条日志上限（含时间/级别前缀）。超出部分丢弃并标注，避免一条日志把终端灌死。 */
export const MAX_LOG_LINE = 4096;
/** 单个字段的截断上限：留 head/tail，中间省略。 */
const MAX_FIELD = 1024;

export function parseLevel(raw: unknown): LevelSetting {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return DEFAULT;
  if (v === "off" || v === "silent" || v === "none") return "off";
  if ((ORDER as string[]).includes(v)) return v as Level;
  // trace 按 verbose 处理（老脚本可能有 DIA_LOG_LEVEL=trace 的习惯）
  if (v === "trace") return "verbose";
  return DEFAULT;
}

/** 当前生效级别。每次调用都读 env：测试里改 process.env 立刻生效，不必重载模块。 */
export function level(): LevelSetting {
  return parseLevel(process.env.DIA_LOG_LEVEL);
}

export function enabled(lv: Level): boolean {
  const cur = level();
  if (cur === "off") return false;
  return ORDER.indexOf(lv) >= ORDER.indexOf(cur);
}

function truncate(s: string, max = MAX_FIELD): string {
  if (s.length <= max) return s;
  const keep = Math.max(8, Math.floor((max - 8) / 2));
  return `${s.slice(0, keep)}…(${s.length - keep * 2}B)…${s.slice(-keep)}`;
}

function render(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return truncate(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Error) return truncate(`${v.name}: ${v.message}`);
  try {
    return truncate(inspect(v, { depth: 3, breakLength: Infinity, compact: true }));
  } catch {
    return truncate(Object.prototype.toString.call(v));
  }
}

/** 结构化字段拼接：`k=v k=v`（值按需序列化+截断）；单行化（换行 → ⏎）。 */
export function fields(f: Record<string, unknown> | undefined): string {
  if (!f) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    parts.push(`${k}=${render(v).replace(/\r?\n/g, "⏎")}`);
  }
  return parts.join(" ");
}

export function line(lv: Level, scope: string, message: string, f?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const tail = fields(f);
  const body = `${ts} ${lv.toUpperCase().padEnd(7)} [${scope}] ${message}${tail ? "  " + tail : ""}`;
  if (body.length <= MAX_LOG_LINE) return body;
  // 硬截断也要保留级别与 scope，便于 grep
  return body.slice(0, MAX_LOG_LINE - 20) + `…(超长,${body.length}B)`;
}

function emit(lv: Level, scope: string, message: string, f?: Record<string, unknown>): void {
  try {
    if (!enabled(lv)) return;
    // 单次 write（避免交错）并吞掉 EPIPE/只读 fd 等一切错误：日志不能反过来打挂业务
    process.stderr.write(line(lv, scope, message, f) + "\n");
  } catch { /* 静默：与 msg-events 同语义 */ }
}

export interface Logger {
  verbose(message: string, f?: Record<string, unknown>): void;
  debug(message: string, f?: Record<string, unknown>): void;
  info(message: string, f?: Record<string, unknown>): void;
  warn(message: string, f?: Record<string, unknown>): void;
  error(message: string, f?: Record<string, unknown>): void;
  child(prefix: string): Logger;
  /** 当前级别下这条会不会输出（调用方想跳过昂贵的快照构造时用） */
  isEnabled(lv: Level): boolean;
}

/** 取一个带 scope 的 logger：`const log = logger("collab.send")`。 */
export function logger(scope: string): Logger {
  const name = scope || "dia";
  return {
    verbose: (m, f) => emit("verbose", name, m, f),
    debug: (m, f) => emit("debug", name, m, f),
    info: (m, f) => emit("info", name, m, f),
    warn: (m, f) => emit("warn", name, m, f),
    error: (m, f) => emit("error", name, m, f),
    child: (prefix) => logger(`${name}.${prefix}`),
    isEnabled: (lv) => enabled(lv),
  };
}

/** 默认 logger（scope 可用 DIA_LOG_SCOPE 标注当前子命令，便于 grep）。 */
export const log: Logger = logger(process.env.DIA_LOG_SCOPE || "dia");
