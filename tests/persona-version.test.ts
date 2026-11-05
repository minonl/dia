import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let repo: string, root: string, home: string;

const run = (args: string[]) =>
  spawnSync(process.execPath, [cli, "persona", ...args], {
    encoding: "utf8",
    env: { ...process.env, DIA_ROOT: root, DIA_CODEX_HOME: home, PATH: process.env.PATH || "/usr/bin:/bin" },
  });

const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dia-ver-repo-"));
  root = mkdtempSync(join(tmpdir(), "dia-ver-root-"));
  home = mkdtempSync(join(tmpdir(), "dia-ver-home-"));
  spawnSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "dia.json"), JSON.stringify({ schema: 1, kind: "persona", id: "p", version: "0.1.0", hosts: ["codex"], entry: { codex: "AGENTS.md" } }));
  writeFileSync(join(repo, "AGENTS.md"), "v1\n");
  git("add", "-A");
  git("commit", "-qm", "v1");
});

describe("persona 版本槽位", () => {
  test("同 semver 不同 commit 并存，不覆盖", () => {
    expect(run(["add", "p", "--from", repo, "--host", "codex"]).status).toBe(0);
    writeFileSync(join(repo, "AGENTS.md"), "v2\n");
    git("add", "-A");
    git("commit", "-qm", "v2");
    expect(run(["add", "p", "--from", repo, "--host", "codex", "--force"]).status).toBe(0);
    const dirs = readdirSync(join(root, "personas", "p")).filter((n) => n.startsWith("0.1.0"));
    expect(dirs.length).toBe(2);
    expect(new Set(dirs).size).toBe(2);
  });

  test("use 0.1.0 前缀可解析到唯一槽位", () => {
    const r = run(["use", "p@0.1.0"]);
    // 两个槽位 → 前缀有歧义，必须报错而不是猜
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("E_VERSION_AMBIGUOUS");
  });
});
