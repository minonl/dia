import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let platforms: any;

beforeAll(async () => { platforms = await import("../src/platforms.ts"); });

describe("版本范围判定", () => {
  test("支持 >= / < / = 与预发布后缀", () => {
    expect(platforms.satisfies("2.2.5", ">=2.0.0 <3.0.0")).toBe(true);
    expect(platforms.satisfies("3.0.0", ">=2.0.0 <3.0.0")).toBe(false);
    expect(platforms.satisfies("0.2.1-rc.2", ">=0.2.0 <0.3.0")).toBe(true);
    expect(platforms.satisfies("1.0.0", null)).toBe(true);
    expect(platforms.satisfies("banana", ">=1.0.0")).toBe(false);
  });

  test("versionOf 从命令输出里取 x.y.z", () => {
    expect(platforms.versionOf("opencode v2.2.5")).toBe("2.2.5");
    expect(platforms.versionOf("0.2.1-rc.2")).toBe("0.2.1");
  });
});

describe("注册表", () => {
  test("load 优先读 DIA_PLATFORMS_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-reg-"));
    const p = join(dir, "registry.json");
    writeFileSync(p, JSON.stringify({
      schema: 1,
      platforms: { fake: { supported: true, render: null, probe: ["--version"], range: ">=1.0.0 <2.0.0", tested: ["1.2.3"], notes: [] } },
    }));
    process.env.DIA_PLATFORMS_FILE = p;
    try {
      const r = platforms.load();
      expect(r.platforms.fake.tested).toEqual(["1.2.3"]);
    } finally { delete process.env.DIA_PLATFORMS_FILE; }
  });

  test("仓库里的 registry.json 可解析且覆盖两台已支持平台", () => {
    process.env.DIA_PLATFORMS_FILE = join(import.meta.dir, "..", "docs", "platforms", "registry.json");
    try {
      const r = platforms.load();
      expect(r.platforms.opencode.supported).toBe(true);
      expect(r.platforms.dsh.supported).toBe(true);
      expect(r.platforms.opencode.range).toContain("2.2.0");
    } finally { delete process.env.DIA_PLATFORMS_FILE; }
  });
});
