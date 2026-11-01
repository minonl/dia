import { describe, expect, test } from "bun:test";
import { parseJsonc, setTopLevelKey, stripJsonc } from "../src/jsonc.ts";

describe("jsonc 读取", () => {
  test("去行注释、块注释、尾逗号", () => {
    const src = `{
  // 行注释
  "a": 1, /* 块注释 */
  "b": [1, 2,],
}`;
    expect(parseJsonc(src)).toEqual({ a: 1, b: [1, 2] });
  });

  test("字符串里的 // 与 ,} 不误伤", () => {
    const src = `{
  "url": "https://example.com/a//b",
  "weird": "x,}",
}`;
    expect(parseJsonc(src)).toEqual({ url: "https://example.com/a//b", weird: "x,}" });
  });

  test("strict JSON 也能解析（幂等）", () => {
    const src = '{"a":1}';
    expect(stripJsonc(src)).toBe(src);
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });
});

describe("jsonc 顶层键编辑（保留原文）", () => {
  const src = `{
  // 用户注释：别删我
  "model": "leyan/kimi", /* 行内注释 */
  "default_agent": "yan",
  "permission": { "read": "allow" }
}`;

  test("改值：注释与其它键保留", () => {
    const next = setTopLevelKey(src, "default_agent", "dabo");
    expect(next).toContain("// 用户注释：别删我");
    expect(next).toContain("/* 行内注释 */");
    expect(parseJsonc(next)).toMatchObject({ model: "leyan/kimi", default_agent: "dabo", permission: { read: "allow" } });
  });

  test("删键：删完仍是合法 JSON", () => {
    const next = setTopLevelKey(src, "default_agent", null);
    expect(next).not.toContain("default_agent");
    expect(parseJsonc(next)).toEqual({ model: "leyan/kimi", permission: { read: "allow" } });
    expect(next).toContain("// 用户注释：别删我");
  });

  test("新增键：插在第一个成员前，不破坏缩进", () => {
    const next = setTopLevelKey('{\n  "model": "x"\n}', "default_agent", "dabo");
    expect(next).toContain('"default_agent": "dabo"');
    expect(parseJsonc(next)).toEqual({ model: "x", default_agent: "dabo" });
  });

  test("空对象新增键", () => {
    const next = setTopLevelKey("{}", "default_agent", "dabo");
    expect(parseJsonc(next)).toEqual({ default_agent: "dabo" });
  });

  test("删不存在的键：幂等", () => {
    expect(setTopLevelKey('{"a":1}', "default_agent", null)).toBe('{"a":1}');
  });
});
