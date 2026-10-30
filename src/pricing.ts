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

export function costOf(model: string | undefined | null, usage: any, table: PriceTable): { usd: number | null; priced: boolean } {
  if (!model) return { usd: null, priced: false };
  const provider = model.split("/")[0];
  const p = table[model] ?? table[`${provider}/*`];
  if (!p) return { usd: null, priced: false };
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  const cache = Number(usage?.cacheReadTokens ?? 0);
  const usd = (input * p.input + output * p.output + cache * (p.cache_read ?? 0)) / 1_000_000;
  return { usd, priced: true };
}
