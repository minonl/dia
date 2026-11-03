import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let home: string, data: string, src: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env,
    DIA_DATA_DIR: data,
    DIA_CACHE_DIR: join(data, "cache"),
    DIA_CODEX_HOME: home,
    DIA_OPENCODE_AGENTS_DIR: join(data, "opencode-agents"),
  },
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-pcodex-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-pcodex-data-"));
  src = mkdtempSync(join(tmpdir(), "dia-pcodex-src-"));
  mkdirSync(join(src, "skills", "demo"), { recursive: true });
  writeFileSync(join(src, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n# demo\n");
  writeFileSync(join(src, "AGENTS.md"), "# role\n你是 role。\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "role", version: "0.1.0", hosts: ["codex"],
    entry: { codex: "AGENTS.md" },
    skills: [{ from: "skills/demo", name: "demo", mode: "link" }],
  }));
});

describe("persona codex host", () => {
  test("install 渲染 AGENTS.md 到隔离 HOME，skills 只落假 HOME", () => {
    const r = run(["persona", "add", "role", "--from", src, "--host", "codex"]);
    expect(r.status).toBe(0);
    const agents = join(home, ".codex", "AGENTS.md");
    expect(existsSync(agents)).toBe(true);
    expect(readFileSync(agents, "utf8")).toContain("你是 role");
    const link = join(home, ".agents", "skills", "demo");
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("render --check 无 drift", () => {
    const r = run(["persona", "render", "role", "--host", "codex", "--check"]);
    expect(r.status).toBe(0);
  });

  test("verify 通过", () => {
    const r = run(["persona", "verify", "role"]);
    expect(r.status).toBe(0);
  });

  test("remove 清理产物与 skills，不碰真实 ~/.agents/skills", () => {
    const r = run(["persona", "remove", "role"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "demo"))).toBe(false);
  });
});
