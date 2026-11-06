import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

describe("generated docs artifacts", () => {
  test("llms-full.txt 是本地生成物，不入库、被 gitignore 覆盖", () => {
    const tracked = git(["ls-files", "--error-unmatch", "llms-full.txt"]);
    expect(tracked.status).not.toBe(0);
    const ignored = git(["check-ignore", "-q", "llms-full.txt"]);
    expect(ignored.status).toBe(0);
  });

  test("docs/index.md 与 llms.txt 仍入库（导航/摘要）", () => {
    for (const f of ["docs/index.md", "llms.txt"]) {
      expect(git(["ls-files", "--error-unmatch", f]).status).toBe(0);
    }
  });
});
