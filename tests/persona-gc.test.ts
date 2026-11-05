import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let repo: string, root: string, home: string;
const run = (args: string[]) => spawnSync(process.execPath, [cli, "persona", ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_CODEX_HOME: home, PATH: process.env.PATH || "/usr/bin:/bin" },
});
const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dia-gc-repo-"));
  root = mkdtempSync(join(tmpdir(), "dia-gc-root-"));
  home = mkdtempSync(join(tmpdir(), "dia-gc-home-"));
  spawnSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@e.com"); git("config", "user.name", "t");
});

function commitVersion(v: string) {
  writeFileSync(join(repo, "dia.json"), JSON.stringify({ schema: 1, kind: "persona", id: "p", version: v, hosts: ["codex"], entry: { codex: "AGENTS.md" } }));
  writeFileSync(join(repo, "AGENTS.md"), `v${v}\n`);
  git("add", "-A"); git("commit", "-qm", v);
}

describe("persona gc", () => {
  test("保留 active + 最近 N，删掉中间版本", () => {
    commitVersion("0.1.0");
    expect(run(["add", "p", "--from", repo, "--host", "codex"]).status).toBe(0);
    commitVersion("0.2.0");
    expect(run(["add", "p", "--from", repo, "--host", "codex", "--force"]).status).toBe(0);
    commitVersion("0.3.0");
    expect(run(["add", "p", "--from", repo, "--host", "codex", "--force"]).status).toBe(0);
    expect(run(["use", "p@0.1.0"]).status).toBe(0);

    const before = readdirSync(join(root, "personas", "p")).filter((n) => /^0\./.test(n));
    expect(before.length).toBe(3);

    const r = run(["gc", "p", "--keep", "1", "--json"]);
    expect(r.status).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res.kept.some((v: string) => v.startsWith("0.1.0"))).toBe(true);
    expect(res.kept.some((v: string) => v.startsWith("0.3.0"))).toBe(true);
    expect(res.removed.some((v: string) => v.startsWith("0.2.0"))).toBe(true);

    const after = readdirSync(join(root, "personas", "p")).filter((n) => /^0\./.test(n));
    expect(after.length).toBe(2);
  });
});
