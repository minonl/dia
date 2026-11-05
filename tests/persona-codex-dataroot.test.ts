import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 多 persona 的 codex 宿主隔离：声明了 data_root 的 persona 渲染到自己的 home，
// 不再抢全局 <data>/codex-home（否则 rendered 哈希互相覆盖 ⇒ verify 恒 fail）。

let data: string, work: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env,
    DIA_DATA_DIR: data,
    DIA_CACHE_DIR: join(data, "cache"),
    // 显式清空，避免其它测试文件/宿主环境把 codex home 钉死
    DIA_CODEX_HOME: "",
    DIA_OPENCODE_AGENTS_DIR: join(data, "opencode-agents"),
  },
});

function makePersona(id: string, dataRoot: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dia-pr-${id}-`));
  writeFileSync(join(dir, "AGENTS.md"), body);
  writeFileSync(join(dir, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id, version: "0.1.0", hosts: ["codex"],
    entry: { codex: "AGENTS.md" },
    data_root: dataRoot,
  }));
  return dir;
}

beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "dia-pdr-data-"));
  work = mkdtempSync(join(tmpdir(), "dia-pdr-work-"));
  mkdirSync(join(work, "a"), { recursive: true });
  mkdirSync(join(work, "b"), { recursive: true });
});

describe("persona codex home 按 data_root 隔离", () => {
  test("两个 persona 各自渲染到自己的 data_root，互不覆盖", () => {
    const a = makePersona("ra", join(work, "a"), "# A\n我是 A。\n");
    const b = makePersona("rb", join(work, "b"), "# B\n我是 B。\n");
    expect(run(["persona", "add", "ra", "--from", a, "--host", "codex"]).status).toBe(0);
    expect(run(["persona", "add", "rb", "--from", b, "--host", "codex"]).status).toBe(0);

    const aAgents = join(work, "a", ".codex", "AGENTS.md");
    const bAgents = join(work, "b", ".codex", "AGENTS.md");
    expect(existsSync(aAgents)).toBe(true);
    expect(existsSync(bAgents)).toBe(true);
    expect(readFileSync(aAgents, "utf8")).toContain("我是 A");
    expect(readFileSync(bAgents, "utf8")).toContain("我是 B");
    // 全局 codex-home 不该被写
    expect(existsSync(join(data, "codex-home", ".codex", "AGENTS.md"))).toBe(false);
  });

  test("两个 persona 的 verify 都通过（不再互相矛盾）", () => {
    expect(run(["persona", "verify", "ra"]).status).toBe(0);
    expect(run(["persona", "verify", "rb"]).status).toBe(0);
  });

  test("重渲染 A 不影响 B", () => {
    expect(run(["persona", "render", "ra"]).status).toBe(0);
    expect(run(["persona", "verify", "ra"]).status).toBe(0);
    expect(run(["persona", "verify", "rb"]).status).toBe(0);
    expect(readFileSync(join(work, "b", ".codex", "AGENTS.md"), "utf8")).toContain("我是 B");
  });

  test("换 home 后旧渲染路径被剪掉（不留下 missing）", () => {
    const c = makePersona("rc", join(work, "c"), "# C\n我是 C。\n");
    const alt = mkdtempSync(join(tmpdir(), "dia-pdr-alt-"));
    expect(run(["persona", "add", "rc", "--from", c, "--host", "codex", "--home", alt]).status).toBe(0);
    const old = join(alt, ".codex", "AGENTS.md");
    expect(existsSync(old)).toBe(true);
    // 再渲染回 data_root：旧路径应被从 lock 剪掉，verify 不报 missing
    expect(run(["persona", "render", "rc"]).status).toBe(0);
    expect(run(["persona", "verify", "rc"]).status).toBe(0);
    expect(existsSync(join(work, "c", ".codex", "AGENTS.md"))).toBe(true);
  });
});
