import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as paths from "./paths.ts";

// 价格表：单位 = USD / Mtok（百万 token）。
// cache_read / cache_write 缺省按 0 计（**缺省 0 是「不另收」，不是「猜价」**）。
export interface Price { input: number; output: number; cache_read?: number; cache_write?: number }
export type PriceTable = Record<string, Price | null>;

/** 为什么没算出来：没给型号 / 型号不在价格表（含 `provider/*` 通配）。 */
export type CostReason = "no-model" | "unknown-model";

export interface Cost {
  usd: number | null;
  priced: boolean;
  /** priced=false 时给原因；priced=true 时不出现 */
  reason?: CostReason;
}

const DEFAULT: PriceTable = {
  "deepseek/deepseek-flash": { input: 0.15, output: 0.6, cache_read: 0.003 },
  "deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cache_read: 0.022 },
  "example/*": { input: 0, output: 0, cache_read: 0 },
};

export function pricesFile(): string {
  return process.env.DIA_PRICES_FILE || join(paths.xdgConfig(), "dia", "prices.json");
}

export function loadPrices(): PriceTable {
  if (!existsSync(pricesFile())) return { ...DEFAULT };
  try {
    const user = JSON.parse(readFileSync(pricesFile(), "utf8")) as PriceTable;
    return { ...DEFAULT, ...user };
  } catch {
    return { ...DEFAULT };
  }
}

/** 取价：精确 → basename → provider 通配 → 跨 provider 同模型名（唯一/同价才用）。 */
const has = (t: PriceTable, k: string) => Object.prototype.hasOwnProperty.call(t, k);

/** 型号归一：`provider/model` → provider + basename（支持 `a/b/c` 形态，basename 取最后一段）。 */
export function modelKeys(model: string): { full: string; base: string; provider: string } {
  const full = String(model || "").trim();
  const slash = full.indexOf("/");
  if (slash < 0) return { full, base: full, provider: "" };
  const provider = full.slice(0, slash);
  const rest = full.slice(slash + 1);
  const base = rest.includes("/") ? rest.slice(rest.lastIndexOf("/") + 1) : rest;
  return { full, base, provider };
}

export function priceFor(model: string, table: PriceTable): Price | null {
  const keys = modelKeys(model);
  // 显式 null = 「明确不计价」，不能再走别名兜底
  if (has(table, keys.full)) return table[keys.full];
  if (keys.base !== keys.full && has(table, keys.base)) return table[keys.base];
  if (keys.provider && has(table, `${keys.provider}/*`)) return table[`${keys.provider}/*`];
  const hits = Object.entries(table)
    .filter(([k, v]) => v && k !== "example/*" && k.split("/").pop() === keys.base)
    .map(([, v]) => v as Price);
  if (!hits.length) return null;
  // 多个 provider 的同名模型：价格一致才用（否则宁可不计价，也不猜）
  const same = hits.every((h) =>
    h.input === hits[0].input &&
    h.output === hits[0].output &&
    (h.cache_read ?? 0) === (hits[0].cache_read ?? 0) &&
    (h.cache_write ?? 0) === (hits[0].cache_write ?? 0));
  return same ? hits[0] : null;
}

export function costOf(model: string | undefined | null, usage: any, table: PriceTable): Cost {
  if (!model || !String(model).trim()) return { usd: null, priced: false, reason: "no-model" };
  const p = priceFor(String(model), table);
  if (!p) return { usd: null, priced: false, reason: "unknown-model" };
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  const cache = Number(usage?.cacheReadTokens ?? 0);
  const cacheWrite = Number(usage?.cacheWriteTokens ?? 0);
  const usd = (input * p.input + output * p.output + cache * (p.cache_read ?? 0) + cacheWrite * (p.cache_write ?? 0)) / 1_000_000;
  return { usd, priced: true };
}
