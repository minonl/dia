import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dsh 插件接线：apply() 注册 systemPrompt.context，text() 返回未读行（不依赖 dsh 运行时）
mock.module("@deepseek-ai/schemastery", () => ({ default: { object: () => ({}) } }));

let root: string;
const prevRoot = process.env.DIA_ROOT;
afterEach(() => { if (prevRoot === undefined) delete process.env.DIA_ROOT; else process.env.DIA_ROOT = prevRoot; });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-dshplug-"));
  mkdirSync(join(root, "collab", "state"), { recursive: true });
  process.env.DIA_ROOT = root;
});

describe("dsh dia-inbox 插件", () => {
  test("apply 注册 context，text() 读 board 输出未读行", async () => {
    writeFileSync(join(root, "collab", "state", "board.json"), JSON.stringify({
      schema: 1, generated_at: new Date().toISOString(), interval_s: 300, undelivered: 2,
    }));
    const mod: any = await import("../kits/dia-msg/dsh/dia-inbox/index.js");
    let registered: any = null;
    const ctx: any = {
      systemPrompt: {
        context: (c: any) => { registered = c; },
        getContextOrder: () => 100,
      },
    };
    mod.apply(ctx);
    expect(registered?.name).toBe("dia-inbox:unread");
    expect(registered.required).toBe(false);
    expect(registered.text()).toContain("2 条未读");
  });

  test("0 未读 → text() 为空（不打扰）", async () => {
    writeFileSync(join(root, "collab", "state", "board.json"), JSON.stringify({
      schema: 1, generated_at: new Date().toISOString(), interval_s: 300, undelivered: 0,
    }));
    const mod: any = await import("../kits/dia-msg/dsh/dia-inbox/index.js");
    let registered: any = null;
    mod.apply({ systemPrompt: { context: (c: any) => { registered = c; }, getContextOrder: () => 100 } });
    expect(registered.text()).toBe("");
  });
});
