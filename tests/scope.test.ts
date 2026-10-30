import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 注意：不 import persona.ts —— 它的目录常量在模块加载时固化，跨测试文件会互相污染。
// 安装一律走 CLI 子进程（隔离 env）。
let scope: any;
let home: string, data: string, src: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dia-scope-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-scope-data-"));
  process.env.DIA_HOME = home;
  process.env.DIA_DATA_DIR = data;
  process.env.DIA_OPENCODE_AGENTS_DIR = mkdtempSync(join(tmpdir(), "dia-scope-agents-"));
  process.env.DIA_CACHE_DIR = mkdtempSync(join(tmpdir(), "dia-scope-cache-"));
  scope = await import("../src/scope.ts");

  src = mkdtempSync(join(tmpdir(), "dia-scope-src-"));
  mkdirSync(join(src, "agents"), { recursive: true });
  mkdirSync(join(src, "kits", "core", "knowledge"), { recursive: true });
  mkdirSync(join(src, "kits", "core", "bin"), { recursive: true });
  writeFileSync(join(src, "agents", "yan.md"), "---\ndescription: yan\nmode: primary\n---\nYou are yan.\n");
  writeFileSync(join(src, "kits", "core", "knowledge", "scenes.md"), "# scenes\n");
  writeFileSync(join(src, "kits", "core", "bin", "scene.mjs"),
    "const [a]=process.argv.slice(2);\nconsole.log('SCENE:'+a+' data='+(process.env.YAN_DATA_ROOT||'-'));\nprocess.exit(a==='S1'?0:5);\n");
  writeFileSync(join(src, "kits", "core", "dia.json"), JSON.stringify({
    schema: 1, kind: "kit", id: "yan-core", version: "0.1.0", root: ".",
    knowledge: ["knowledge"],
    data_root: "~/.yan-agent",
    dirs: ["~/.yan-agent/cache"],
    commands: [{ name: "scene", entry: "bin/scene.mjs", env: { YAN_DATA_ROOT: "~/.yan-agent" } }],
  }));
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "yan", version: "0.1.0",
    hosts: ["opencode"], entry: { opencode: "agents/yan.md" },
    kits: ["./kits/core"],
  }));
});

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const runCli = (args: string[], extraEnv: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_HOME: home, DIA_DATA_DIR: data, DIA_PERSONA: "", ...extraEnv },
});

describe("persona → kit 联动", () => {
  test("install persona 会把引用的 kit 一并装上并记账", () => {
    const r = runCli(["persona", "add", "--from", src]);
    expect(r.status).toBe(0);
    const lock = JSON.parse(readFileSync(join(data, "personas", "yan", "0.1.0", "dia.lock"), "utf8"));
    expect(lock.kits).toEqual([{ id: "yan-core", version: "0.1.0" }]);
    expect(existsSync(join(data, "kits", "yan-core", "0.1.0", "knowledge", "scenes.md"))).toBe(true);
  });

  test("scope 解析出知识根 / 数据根 / 命令", () => {
    const s = scope.current("yan");
    expect(s.id).toBe("yan");
    expect(s.knowledgeRoot).toBe(join(data, "kits", "yan-core", "0.1.0", "knowledge"));
    expect(s.dataRoot).toBe(join(home, ".yan-agent"));
    expect(s.kits[0].commands[0].name).toBe("scene");
  });

  test("多 persona 未指定 → E_SCOPE；显式指定 → ok", () => {
    const other = mkdtempSync(join(tmpdir(), "dia-scope-other-"));
    mkdirSync(join(other, "agents"), { recursive: true });
    writeFileSync(join(other, "agents", "dabo.md"), "---\ndescription: dabo\n---\nYou are dabo.\n");
    writeFileSync(join(other, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "dabo", version: "0.1.0", hosts: ["opencode"], entry: { opencode: "agents/dabo.md" },
    }));
    const r = runCli(["persona", "add", "--from", other]);
    expect(r.status).toBe(0);
    expect(() => scope.current()).toThrow(/E_SCOPE/);
    expect(scope.current("yan").id).toBe("yan");
  });
});

describe("dia kb 作用域与委派", () => {
  const run = (args: string[]) => runCli(args, { DIA_PERSONA: "yan" });

  test("dia kb scene S1 → 委派到 kit 命令，注入数据根", () => {
    const r = run(["kb", "scene", "S1"]);
    expect(r.stdout).toContain("SCENE:S1");
    expect(r.stdout).toContain(join(home, ".yan-agent"));
    expect(r.status).toBe(0);
  });

  test("exit code 原样透传（S2 → 5）", () => {
    const r = run(["kb", "scene", "S2"]);
    expect(r.status).toBe(5);
  });

  test("内置子命令优先级高于委派：dia kb get 用知识根", () => {
    const r = run(["kb", "get", "scenes.md"]);
    expect(r.stdout).toContain("# scenes");
    expect(r.status).toBe(0);
  });

  test("--persona 不装时报错，不静默", () => {
    const r = run(["--persona", "nobody", "kb", "get", "scenes.md"]);
    expect(r.stderr).toContain("not installed");
    expect(r.status).not.toBe(0);
  });
});
