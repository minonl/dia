import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// npm 包不带 registry/ 目录；deps/platforms 必须回退到包内 docs/
let deps: any, platforms: any;

beforeAll(async () => {
  deps = await import("../src/deps.ts");
  platforms = await import("../src/platforms.ts");
});

describe("npm 包内的 docs 回退", () => {
  test("deps 从 <install>/docs/deps.jsonl 读", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-pack-deps-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    const row = { id: "host_cli:x@1.0.0", kind: "host_cli", version: "1.0.0", role: "optional" };
    writeFileSync(join(dir, "docs", "deps.jsonl"), JSON.stringify(row) + "\n");
    process.env.DIA_INSTALL_DIR = dir;
    try {
      const rows = deps.load();
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe("host_cli:x@1.0.0");
    } finally { delete process.env.DIA_INSTALL_DIR; }
  });

  test("platforms 从 <install>/docs/platforms/registry.json 读", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-pack-plat-"));
    mkdirSync(join(dir, "docs", "platforms"), { recursive: true });
    writeFileSync(join(dir, "docs", "platforms", "registry.json"), JSON.stringify({
      schema: 1, platforms: { fake: { supported: true, render: null, probe: ["--version"], range: null, tested: [], notes: [] } },
    }));
    process.env.DIA_INSTALL_DIR = dir;
    try {
      const reg = platforms.load();
      expect(reg?.platforms?.fake?.supported).toBe(true);
    } finally { delete process.env.DIA_INSTALL_DIR; }
  });
});
