import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Price { input: number; output: number; cache_read?: number }
export type PriceTable = Record<string, Price | null>;

const DEFAULT: PriceTable = {
  "deepseek/deepseek-flash": { input: 0.15, output: 0.6, cache_read: 0.003 },
  "deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cache_read: 0.022 },
  "example/*": { input: 0, output: 0, cache_read: 0 },
};

export function pricesFile(): string {
  return process.env.DIA_PRICES_FILE || join(homedir(), ".config", "dia", "prices.json");
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

/** 取价：精确 → provider 通配 → 同模型名（跨 provider 别名，唯一/同价才用）。 */
const has = (t: PriceTable, k: string) => Object.prototype.hasOwnProperty.call(t, k);

export function priceFor(model: string, table: PriceTable): Price | null {
  // 显式 null = 「明确不计价」，不能再走别名兜底
  if (has(table, model)) return table[model];
  const [provider, ...rest] = model.split("/");
  const wildcardKey = `${provider}/*`;
  if (has(table, wildcardKey)) return table[wildcardKey];
  const name = rest.join("/");
  const hits = Object.entries(table)
    .filter(([k, v]) => v && k !== "example/*" && k.split("/").slice(1).join("/") === name)
    .map(([, v]) => v as Price);
  if (!hits.length) return null;
  // 多个 provider 的同名模型：价格一致才用（否则宁可不计价，也不猜）
  return hits.every((h) => h.input === hits[0].input && h.output === hits[0].output) ? hits[0] : null;
}

export function costOf(model: string | undefined | null, usage: any, table: PriceTable): { usd: number | null; priced: boolean } {
  if (!model) return { usd: null, priced: false };
  const p = priceFor(model, table);
  if (!p) return { usd: null, priced: false };
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  const cache = Number(usage?.cacheReadTokens ?? 0);
  const usd = (input * p.input + output * p.output + cache * (p.cache_read ?? 0)) / 1_000_000;
  return { usd, priced: true };
}
