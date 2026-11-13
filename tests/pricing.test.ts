import { describe, expect, test } from "bun:test";
import { costOf, loadPrices } from "../src/pricing.ts";

describe("pricing", () => {
  test("known model cost", () => {
    const p = loadPrices();
    const c = costOf("deepseek/deepseek-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, p);
    expect(c.priced).toBe(true);
    expect(c.usd).toBeCloseTo(0.75, 6);
  });

  test("example is free", () => {
    const p = loadPrices();
    const c = costOf("example/deepseek-v4.1-flash", { inputTokens: 1000, outputTokens: 100 }, p);
    expect(c.priced).toBe(true);
    expect(c.usd).toBe(0);
  });

  test("provider 别名：同模型名跨 provider 也能计价", () => {
    const p = loadPrices();
    // dsh 报的是 deepseek-account/deepseek-flash；价目表里是 deepseek/deepseek-flash
    const c = costOf("deepseek-account/deepseek-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, p);
    expect(c.priced).toBe(true);
    expect(c.usd).toBeCloseTo(0.75, 6);
    // 不同模型名不猜价
    expect(costOf("deepseek-account/deepseek-v4-flash", { inputTokens: 1, outputTokens: 1 }, p).priced).toBe(false);
  });

  test("显式 null = 明确不计价，不会被别名兜底", () => {
    const t: any = { "deepseek/deepseek-flash": { input: 0.15, output: 0.6 }, "deepseek-account/deepseek-flash": null };
    expect(costOf("deepseek-account/deepseek-flash", { inputTokens: 1e6, outputTokens: 1e6 }, t).priced).toBe(false);
    expect(costOf("deepseek-account/*", { inputTokens: 1e6, outputTokens: 1e6 }, t).priced).toBe(false);
  });

  test("unknown model stays unknown", () => {
    const c = costOf("x/y", { inputTokens: 1, outputTokens: 1 }, loadPrices());
    expect(c.priced).toBe(false);
  });
});
