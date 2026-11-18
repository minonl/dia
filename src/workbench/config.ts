// dia workbench —— 数据白名单与配额（唯一事实源）
//
// 设计：docs/design/workbench.md §3.6
// 原则：
//   · 只有 whitelist 里的文件是「资产」；其余一律视为可随时清除
//   · 每个白名单文件必须有硬上限（字节/行数）与溢出策略
//   · 删除只发生在 workbench 根内；不跟随符号链接

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as paths from "../paths.ts";

export type OverflowPolicy = "fail" | "rotate" | "compact";

export interface DurableRule {
  path: string;            // 相对 workbench 根
  why: string;
  max_bytes: number;
  max_lines: number;
  on_overflow: OverflowPolicy;
}

export interface EphemeralRule {
  path: string;            // 相对路径或 `dir/**`
  ttl_h: number;
  max_bytes?: number;
  max_lines?: number;
  on_overflow?: OverflowPolicy;
}

export interface WorkbenchConfig {
  schema_v: 1;
  durable: DurableRule[];
  ephemeral: EphemeralRule[];
  quota: { root_max_bytes: number; warn_ratio: number };
}

const MB = 1024 * 1024;

export const DEFAULT_CONFIG: WorkbenchConfig = {
  schema_v: 1,
  durable: [
    { path: "tracks.jsonl", why: "track 意图事实源", max_bytes: 8 * MB, max_lines: 50_000, on_overflow: "compact" },
    { path: "queue.jsonl", why: "未投递消息（丢了就是丢消息）", max_bytes: 2 * MB, max_lines: 2_000, on_overflow: "fail" },
    { path: "config.json", why: "白名单自身", max_bytes: 64 * 1024, max_lines: 2_000, on_overflow: "fail" },
  ],
  ephemeral: [
    { path: "derived/**", ttl_h: 72 },
    { path: "beats.jsonl", ttl_h: 720, max_bytes: 2 * MB, max_lines: 50_000, on_overflow: "rotate" },
    { path: "drift.jsonl", ttl_h: 168, max_bytes: 2 * MB, max_lines: 5_000, on_overflow: "rotate" },
  ],
  quota: { root_max_bytes: 100 * MB, warn_ratio: 0.8 },
};

export const configPath = () => join(paths.diaHome(), "workbench", "config.json");

/** 读配置；缺失/损坏/版本不符 → 回落内置默认（白名单永远可用）。 */
export function loadConfig(): { config: WorkbenchConfig; source: "file" | "default"; bad?: string } {
  const p = configPath();
  if (!existsSync(p)) return { config: DEFAULT_CONFIG, source: "default" };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as WorkbenchConfig;
    if (raw?.schema_v !== 1 || !Array.isArray(raw.durable) || !Array.isArray(raw.ephemeral)) {
      return { config: DEFAULT_CONFIG, source: "default", bad: "schema 不匹配" };
    }
    return { config: raw, source: "file" };
  } catch (e: any) {
    return { config: DEFAULT_CONFIG, source: "default", bad: e?.message || String(e) };
  }
}

export function matchPattern(rel: string, pattern: string): boolean {
  const norm = rel.split("\\").join("/");
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return norm === base || norm.startsWith(base + "/");
  }
  return norm === pattern;
}

export interface WriteVerdict {
  allowed: boolean;
  rule?: DurableRule | EphemeralRule;
  reason?: string;
}

/** 写前校验：只有白名单（durable 精确匹配 / ephemeral 模式）允许写。 */
export function verdictFor(rel: string): WriteVerdict {
  const { config } = loadConfig();
  const norm = rel.split("\\").join("/");
  if (norm.startsWith("..") || norm.startsWith("/")) return { allowed: false, reason: "E_WB_WHITELIST: 不允许绝对路径或 .." };
  for (const rule of config.durable) if (matchPattern(norm, rule.path)) return { allowed: true, rule };
  for (const rule of config.ephemeral) if (matchPattern(norm, rule.path)) return { allowed: true, rule };
  return { allowed: false, reason: `E_WB_WHITELIST: ${norm} 不在白名单（可随时清除的文件不应持久化）` };
}
