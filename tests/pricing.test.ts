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

  test("unknown model stays unknown", () => {
    const c = costOf("x/y", { inputTokens: 1, outputTokens: 1 }, loadPrices());
    expect(c.priced).toBe(false);
  });
});
