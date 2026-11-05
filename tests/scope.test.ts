import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** 新布局：版本槽位 = <semver>+g<sha>（同 semver 不同 commit 并存） */
function slotDir(root: string, id: string, prefix = "0.1.0"): string {
  const dir = join(root, "personas", id);
  const name = readdirSync(dir).find((n) => n.startsWith(prefix))!;
  return join(dir, name);
}


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
  // argv[0] = 子命令（dia 注入），argv[1] = 首个参数
  writeFileSync(join(src, "kits", "core", "bin", "scene.mjs"),
    "const [sub,a]=process.argv.slice(2);\nconsole.log('SUB:'+sub+' ARG:'+a+' data='+(process.env.YAN_DATA_ROOT||'-'));\nprocess.exit(a==='S1'?0:5);\n");
  // bash 运行时：入口自己解析子命令（dia 不注入命令名），并透传退出码
  writeFileSync(join(src, "kits", "core", "bin", "echo.sh"),
    "#!/usr/bin/env bash\nprintf 'BASH ARGS:%s DATA:%s\\n' \"$*\" \"${DIA_DATA_ROOT:-none}\"\nexit 7\n");
  writeFileSync(join(src, "kits", "core", "dia.json"), JSON.stringify({
    schema: 1, kind: "kit", id: "yan-core", version: "0.1.0", root: ".",
    knowledge: ["knowledge"],
    data_root: "~/.yan-agent",
    dirs: ["~/.yan-agent/cache"],
    commands: [
      { name: "scene", entry: "bin/scene.mjs", env: { YAN_DATA_ROOT: "~/.yan-agent" } },
      { name: "hello", entry: "bin/scene.mjs", env: { YAN_DATA_ROOT: "~/.yan-agent" } },
      { name: "kit", entry: "bin/scene.mjs" },
      { name: "shout", entry: "bin/echo.sh", runtime: "bash" },
    ],
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
    const lock = JSON.parse(readFileSync(join(slotDir(data, "yan"), "dia.lock"), "utf8"));
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

  test("旧 lock（缺 content）→ 用安装目录 dia.json 兜底知识根与命令", () => {
    const src2 = mkdtempSync(join(tmpdir(), "dia-scope-legacy-"));
    mkdirSync(join(src2, "agents"), { recursive: true });
    mkdirSync(join(src2, "knowledge"), { recursive: true });
    writeFileSync(join(src2, "knowledge", "a.md"), "# a\n");
    writeFileSync(join(src2, "agents", "legacy.md"), "---\ndescription: legacy\n---\nYou are legacy.\n");
    writeFileSync(join(src2, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "legacy", version: "0.1.0", hosts: ["opencode"],
      entry: { opencode: "agents/legacy.md" }, knowledge: ["knowledge"],
      commands: [{ name: "old", entry: "agents/legacy.md" }],
    }));
    expect(runCli(["persona", "add", "--from", src2]).status).toBe(0);

    // 模拟早期 add 落下的 lock：没有 content 段
    const lockPath = join(slotDir(data, "legacy"), "dia.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    delete lock.content;
    writeFileSync(lockPath, JSON.stringify(lock));

    const s = scope.current("legacy");
    expect(s.knowledgeRoot).toBe(join(slotDir(data, "legacy"), "knowledge"));
    expect(s.kits[0].commands[0].name).toBe("old");
  });
});

describe("一级委派（A）与 dia cmd（B）", () => {
  const run = (args: string[]) => runCli(args, { DIA_PERSONA: "yan" });

  test("A：未知一级命令 → persona 命令；argv 带命令名", () => {
    const r = run(["hello", "S1"]);
    expect(r.stdout).toContain("SUB:hello ARG:S1");
    expect(r.status).toBe(0);
  });

  test("A：bash 命令不注入命令名，退出码原样透传", () => {
    const r = run(["shout", "a", "b"]);
    expect(r.stdout).toContain("BASH ARGS:a b");
    expect(r.stdout).toContain("DATA:" + join(home, ".yan-agent"));
    expect(r.status).toBe(7);
  });

  test("A：内置命令优先，persona 同名不覆盖", () => {
    const r = run(["kit", "list"]);            // persona 声明了 kit，但内置 kit 必须赢
    expect(r.stdout).toContain("yan-core");
    expect(r.stdout).not.toContain("SUB:kit");
  });

  test("B：dia cmd 只查外部命令 → 同名也不回退内置", () => {
    const r = run(["cmd", "kit", "list"]);
    expect(r.stdout).toContain("SUB:kit ARG:list");
  });

  test("B：外部没声明 → E_CMD + 非 0", () => {
    const r = run(["cmd", "nope"]);
    expect(r.stderr).toContain("E_CMD");
    expect(r.status).toBe(34);
  });
});

describe("persona remove 回收自带内容", () => {
  test("remove 后 agent md / AGENTS.md / skill 软链消失，dirs 保留", () => {
    const r = runCli(["persona", "remove", "yan"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".config/opencode/agents/yan.md"))).toBe(false);
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, ".agents/skills/onboarding"))).toBe(false);
    expect(existsSync(join(home, ".yan-agent/cache"))).toBe(true);
    // 重装回去，后面的 kb 测试还要用
    expect(runCli(["persona", "add", "--from", src]).status).toBe(0);
  });
});

describe("dia kb 作用域与委派", () => {
  const run = (args: string[]) => runCli(args, { DIA_PERSONA: "yan" });

  test("dia kb scene S1 → 委派到 kit 命令，注入数据根", () => {
    const r = run(["kb", "scene", "S1"]);
    expect(r.stdout).toContain("SUB:scene ARG:S1");
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
