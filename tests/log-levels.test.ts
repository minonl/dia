import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as log from "../src/log.ts";

// 直接测模块（级别解析/截断/单条上限），不走子进程
describe("log：级别解析", () => {
  test("默认 verbose；off/silent 关掉；非法值回落 verbose", () => {
    expect(log.parseLevel(undefined)).toBe("verbose");
    expect(log.parseLevel("")).toBe("verbose");
    expect(log.parseLevel("OFF")).toBe("off");
    expect(log.parseLevel("silent")).toBe("off");
    expect(log.parseLevel("debug")).toBe("debug");
    expect(log.parseLevel("WARN")).toBe("warn");
    expect(log.parseLevel("trace")).toBe("verbose"); // 老习惯
    expect(log.parseLevel("nonsense")).toBe("verbose");
  });

  test("单条 < 4KB；超长字段头尾保留 + 标注", () => {
    const big = "x".repeat(50_000);
    const l = log.line("verbose", "test", "big", { payload: big });
    expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(log.MAX_LOG_LINE);
    expect(l).toContain("B)");
    // 正常条目原样可读
    const ok = log.line("info", "test", "hi", { a: 1, b: "two" });
    expect(ok).toContain("INFO");
    expect(ok).toContain("[test]");
    expect(ok).toContain("a=1");
    expect(ok).toContain("b=two");
  });

  test("字段里的换行被单行化（不破坏一行一条）", () => {
    const l = log.line("warn", "test", "multi", { body: "line1\nline2" });
    expect(l.split("\n").length).toBe(1);
    expect(l).toContain("line1⏎line2");
  });

  test("Error 值渲染为 Name: message", () => {
    const l = log.line("error", "test", "boom", { err: new Error("bad thing") });
    expect(l).toContain("Error: bad thing");
  });
});
