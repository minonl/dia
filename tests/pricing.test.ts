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

  // ── §8.1 补强：不猜价 / 归一 / cache_write ────────────────────────────────

  test("未知 leyan 型号不猜价：usd null / priced false / reason unknown-model", () => {
    const c = costOf("leyantech/deepseek-v4.1-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, {});
    expect(c.usd).toBe(null);
    expect(c.priced).toBe(false);
    expect(c.reason).toBe("unknown-model");
    // 0 token 也不等于免费：没价格就不给 0
    expect(costOf("leyantech/x", {}, {}).usd).toBe(null);
  });

  test("没给型号 → reason no-model", () => {
    const c = costOf(undefined, { inputTokens: 1 }, {});
    expect(c.priced).toBe(false);
    expect(c.reason).toBe("no-model");
  });

  test("已有 deepseek 条目价格不变（默认表）", () => {
    const p = loadPrices();
    expect(p["deepseek/deepseek-flash"]).toEqual({ input: 0.15, output: 0.6, cache_read: 0.003 });
    expect(p["deepseek/deepseek-v4-pro"]).toEqual({ input: 0.66, output: 1.98, cache_read: 0.022 });
    expect(p["example/*"]).toEqual({ input: 0, output: 0, cache_read: 0 });
    const c = costOf("deepseek/deepseek-v4-pro", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, p);
    expect(c.priced).toBe(true);
    expect(c.usd).toBeCloseTo(0.66 + 1.98 + 0.022, 9);
  });

  test("cache_write 缺省按 0 计（不额外收费）", () => {
    const table = loadPrices();
    const base = costOf("deepseek/deepseek-flash", { inputTokens: 1000, outputTokens: 100 }, table);
    const withWrite = costOf("deepseek/deepseek-flash", { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 1_000_000 }, table);
    expect(withWrite.usd).toBe(base.usd);
  });

  test("显式 cache_write 价格被计入", () => {
    const table = { "leyantech/*": { input: 1, output: 2, cache_read: 0.1, cache_write: 3 } };
    const c = costOf("leyantech/deepseek-v4.1-flash", { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }, table);
    expect(c.priced).toBe(true);
    expect(c.usd).toBeCloseTo(4, 9); // 1 + 3
  });

  test("型号归一：完整型号 → basename → provider/*", () => {
    const base = { input: 1, output: 2 };
    // basename 命中
    const byBase = costOf("deepseek/deepseek-flash", { inputTokens: 1_000_000, outputTokens: 0 }, { "deepseek-flash": base });
    expect(byBase.priced).toBe(true);
    expect(byBase.usd).toBeCloseTo(1, 9);
    // 完整型号优先于 basename
    const exact = costOf(
      "deepseek/deepseek-flash",
      { inputTokens: 1_000_000, outputTokens: 0 },
      { "deepseek/deepseek-flash": { input: 9, output: 9 }, "deepseek-flash": base },
    );
    expect(exact.usd).toBeCloseTo(9, 9);
    // 多级路径取最后一段 basename
    const deep = costOf("a/b/deepseek-flash", { inputTokens: 1_000_000, outputTokens: 0 }, { "deepseek-flash": base });
    expect(deep.usd).toBeCloseTo(1, 9);
    // provider/* 通配
    const wild = costOf("other/model", { inputTokens: 0, outputTokens: 1_000_000 }, { "other/*": base });
    expect(wild.usd).toBeCloseTo(2, 9);
    // 表里显式 null 视作没有价格（不猜价）
    expect(costOf("deepseek/deepseek-flash", { inputTokens: 1 }, { "deepseek/deepseek-flash": null }).priced).toBe(false);
  });
});
