import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let persona: any;
let home: string, data: string, cfg: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dia-def-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-def-data-"));
  process.env.DIA_DATA_DIR = data;
  process.env.DIA_HOME = home;
  cfg = join(home, "opencode.json");
  process.env.DIA_OPENCODE_CONFIG = cfg;
  mkdirSync(join(home), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ model: "x", permission: { a: "allow" } }, null, 2) + "\n");
  persona = await import("../src/persona.ts");
});

describe("persona default agent", () => {
  test("设置默认 agent，保留其它键，写备份与原值", () => {
    const r = persona.setDefaultAgent("yan");
    const cfg = JSON.parse(readFileSync(join(home, "opencode.json"), "utf8"));
    expect(cfg.default_agent).toBe("yan");
    expect(cfg.model).toBe("x");
    expect(cfg.permission.a).toBe("allow");
    expect(r.previous).toBe(null);
    expect(existsSync(r.backup!)).toBe(true);
  });

  test("show 读到当前值", () => {
    expect(persona.showDefaultAgent().current).toBe("yan");
  });

  test("改设另一个 persona，previous 记录原值", () => {
    const r = persona.setDefaultAgent("dabo");
    expect(r.previous).toBe("yan");
    expect(persona.showDefaultAgent().current).toBe("dabo");
  });

  test("--unset 移除键，其它键不动", () => {
    persona.setDefaultAgent(null);
    const cfg = JSON.parse(readFileSync(join(home, "opencode.json"), "utf8"));
    expect(cfg.default_agent).toBeUndefined();
    expect(cfg.model).toBe("x");
  });

  test("配置文件不存在 → E_CONFIG", () => {
    process.env.DIA_OPENCODE_CONFIG = join(home, "nope.json");
    expect(() => persona.setDefaultAgent("yan")).toThrow(/E_CONFIG/);
    process.env.DIA_OPENCODE_CONFIG = cfg;
  });
});
