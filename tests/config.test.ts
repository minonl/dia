import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let config: any;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dia-cfg-"));
  process.env.DIA_HOME = home;
  process.env.DIA_DATA_DIR = mkdtempSync(join(tmpdir(), "dia-cfg-data-"));
  config = await import("../src/config.ts");
});

describe("JSONC 解析", () => {
  test("去注释与尾逗号，但不伤 URL", () => {
    const src = `{
      // 主机
      "baseURL": "https://x/v1", /* 行尾 */
      "list": [1, 2,],
    }`;
    const d = config.parse(src, true);
    expect(d.baseURL).toBe("https://x/v1");
    expect(d.list).toEqual([1, 2]);
  });

  test("字符串里的 // 不当注释", () => {
    expect(config.parse('{"u":"git+https://a//b"}', true).u).toBe("git+https://a//b");
  });
});

describe("apply / revert", () => {
  test("只改声明键，其它键保留，写备份", () => {
    const f = join(home, "cfg.json");
    writeFileSync(f, JSON.stringify({ model: "m", permission: { a: "allow" } }, null, 2) + "\n");
    const r = config.apply([{ file: f, set: { "permission.external_directory": { "~/.yan-agent/**": "allow" } } }]);
    const d = JSON.parse(readFileSync(f, "utf8"));
    expect(d.model).toBe("m");
    expect(d.permission.a).toBe("allow");
    expect(d.permission.external_directory["~/.yan-agent/**"]).toBe("allow");
    expect(existsSync(r[0].backup)).toBe(true);
  });

  test("revert 逐字节还原", () => {
    const f = join(home, "cfg2.json");
    const before = '{\n  "a": 1\n}\n';
    writeFileSync(f, before);
    const r = config.apply([{ file: f, set: { b: 2 } }]);
    const rv = config.revert(r);
    expect(rv.restored).toEqual([f]);
    expect(readFileSync(f, "utf8")).toBe(before);
  });

  test("文件被用户改过 → revert skip，不覆盖", () => {
    const f = join(home, "cfg3.json");
    writeFileSync(f, '{"a":1}\n');
    const r = config.apply([{ file: f, set: { b: 2 } }]);
    writeFileSync(f, '{"a":1,"b":2,"mine":true}\n');
    const rv = config.revert(r);
    expect(rv.skipped).toEqual([f]);
    expect(readFileSync(f, "utf8")).toContain("mine");
  });

  test("jsonc 文件写回 canonical JSON，并标记注释丢失", () => {
    const f = join(home, "cfg.jsonc");
    writeFileSync(f, '{\n  // 注释\n  "a": 1\n}\n');
    const r = config.apply([{ file: f, jsonc: true, set: { b: 2 } }]);
    expect(r[0].comments_lost).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8")).b).toBe(2);
  });

  test("严格 JSON 解析失败 → E_CONFIG", () => {
    const f = join(home, "bad.json");
    writeFileSync(f, '{oops');
    expect(() => config.apply([{ file: f, set: { a: 1 } }])).toThrow(/E_CONFIG/);
  });
});
