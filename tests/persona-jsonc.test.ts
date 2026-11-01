import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// opencode 的全局配置可以是 opencode.json 或 opencode.jsonc，dia 必须都能读能写。
let persona: any;
let dir: string, data: string;

const JSONC = `{
  // 用户注释，写回时必须保留
  "model": "leyan/kimi",
  "default_agent": "yan",
  "permission": { "read": "allow" },
}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dia-jsonc-cfg-"));
  data = mkdtempSync(join(tmpdir(), "dia-jsonc-data-"));
  process.env.DIA_DATA_DIR = data;
  process.env.DIA_OPENCODE_CONFIG_DIR = dir;
  delete process.env.DIA_OPENCODE_CONFIG;
  persona = await import("../src/persona.ts");
});

describe("opencode 配置发现", () => {
  test("只有 .jsonc 时命中 .jsonc，并能读注释里的配置", () => {
    const f = join(dir, "opencode.jsonc");
    writeFileSync(f, JSONC);
    expect(persona.opencodeConfig()).toBe(f);
    expect(persona.showDefaultAgent().current).toBe("yan");
  });

  test("两者都存在时按宿主顺序优先 .json", () => {
    const j = join(dir, "opencode.json");
    writeFileSync(j, '{"default_agent":"json-first"}');
    expect(persona.opencodeConfig()).toBe(j);
    expect(persona.showDefaultAgent().current).toBe("json-first");
  });
});

describe("在 .jsonc 上写默认 agent", () => {
  test("改值：保留注释，其它键不动", () => {
    // 回到只有 .jsonc 的状态
    const j = join(dir, "opencode.json");
    if (existsSync(j)) unlinkSync(j);
    const r = persona.setDefaultAgent("dabo");
    expect(r.previous).toBe("yan");
    const raw = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    expect(raw).toContain("// 用户注释，写回时必须保留");
    expect(raw).toContain('"default_agent": "dabo"');
    expect(raw).toContain('"model": "leyan/kimi"');
    expect(persona.showDefaultAgent().current).toBe("dabo");
  });

  test("--unset：删键后仍是合法 JSONC", () => {
    persona.setDefaultAgent(null);
    const raw = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    expect(raw).not.toContain("default_agent");
    expect(raw).toContain("// 用户注释，写回时必须保留");
    expect(persona.showDefaultAgent().current).toBe(null);
  });
});
