import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cwd = join(import.meta.dir, "..");
function cli(args: string[]) {
  return spawnSync(process.execPath, ["src/cli.ts", "kb", "path", ...args], { cwd, encoding: "utf8" });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dia-kb-path-"));
  const root = join(dir, "kb"); const repo = join(dir, "repo");
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(repo, "skills", "demo"), { recursive: true });
  mkdirSync(join(repo, "tools"), { recursive: true });
  writeFileSync(join(root, "workflows", "flow.md"), "# Flow\n");
  writeFileSync(join(root, "doc.md"), "# Doc\n");
  writeFileSync(join(repo, "skills", "demo", "SKILL.md"), "# Skill\n");
  writeFileSync(join(repo, "tools", "x.sh"), "#!/bin/sh\n");
  return { root, repo };
}

describe("kb path", () => {
  test("workflow/doc", () => {
    const { root } = fixture();
    const w = cli(["workflow:flow", "--root", root, "--json"]);
    expect(w.status).toBe(0);
    expect(JSON.parse(w.stdout).path).toEndWith("workflows/flow.md");
    const d = cli(["doc:doc", "--root", root]);
    expect(d.status).toBe(0);
    expect(d.stdout.trim()).toEndWith("doc.md");
  });

  test("skill/tool with repo root", () => {
    const { root, repo } = fixture();
    const s = cli(["skill:demo", "--root", root, "--repo", repo, "--json"]);
    expect(s.status).toBe(0);
    expect(JSON.parse(s.stdout).path).toEndWith("skills/demo/SKILL.md");
    const t = cli(["tool:tools/x.sh#run", "--root", root, "--repo", repo]);
    expect(t.status).toBe(0);
    expect(t.stdout.trim()).toContain("bash ");
    expect(t.stdout.trim()).toEndWith("x.sh run");
  });

  test("escape and missing addresses", () => {
    const { root } = fixture();
    expect(cli(["doc:../escape", "--root", root]).status).toBe(2);
    expect(cli(["workflow:nope", "--root", root]).status).toBe(4);
    expect(cli(["unknown:thing", "--root", root]).status).toBe(2);
  });
});
