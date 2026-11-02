import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let home: string, data: string, src: string, cfg: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_HOME: home, DIA_DATA_DIR: data, DIA_CACHE_DIR: join(data, "cache"), DIA_OPENCODE_AGENTS_DIR: join(home, "agents"), DIA_OPENCODE_CONFIG: cfg },
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-pcfg-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-pcfg-data-"));
  src = mkdtempSync(join(tmpdir(), "dia-pcfg-src-"));
  cfg = join(home, "opencode.json");
  writeFileSync(cfg, JSON.stringify({ model: "m", permission: { a: "allow" } }, null, 2) + "\n");
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "agents", "yan.md"), "---\ndescription: y\n---\nbody\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "yan", version: "0.1.0", hosts: ["opencode"],
    entry: { opencode: "agents/yan.md" },
    config: [{ file: cfg, set: { "permission.external_directory": { "~/.yan-agent/**": "allow" } } }],
  }));
});

describe("persona config 合并", () => {
  test("install 应用声明配置，保留其它键", () => {
    expect(run(["persona", "add", "--from", src]).status).toBe(0);
    const d = JSON.parse(readFileSync(cfg, "utf8"));
    expect(d.model).toBe("m");
    expect(d.permission.a).toBe("allow");
    expect(d.permission.external_directory["~/.yan-agent/**"]).toBe("allow");
  });

  test("remove 按原内容回滚，其它键保持原样", () => {
    expect(run(["persona", "remove", "yan"]).status).toBe(0);
    const d = JSON.parse(readFileSync(cfg, "utf8"));
    expect(d.permission.external_directory).toBeUndefined();
    expect(d.permission.a).toBe("allow");
    expect(d.model).toBe("m");
  });
});
