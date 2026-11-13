import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, gitHead, normalizeVerify } from "../src/team.ts";

const git = (ws: string, args: string[]) =>
  execFileSync("git", ["-C", ws, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function repoWithCommit() {
  const ws = mkdtempSync(join(tmpdir(), "dia-diff-"));
  git(ws, ["init", "-q"]);
  writeFileSync(join(ws, "a.txt"), "one\n");
  git(ws, ["add", "."]);
  git(ws, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  return ws;
}

describe("团队 diff 的基准（builder 提交后不能是空 diff）", () => {
  test("gitHead 读得到基准 commit", () => {
    const ws = repoWithCommit();
    expect(gitHead(ws)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("未提交改动：diff 有内容", () => {
    const ws = repoWithCommit();
    const base = gitHead(ws)!;
    writeFileSync(join(ws, "a.txt"), "two\n");
    expect(gitDiff(ws, base)).toContain("-one");
  });

  test("已提交改动：带基准仍能看到（回归：RT-1 的副作用）", () => {
    const ws = repoWithCommit();
    const base = gitHead(ws)!;
    writeFileSync(join(ws, "a.txt"), "two\n");
    git(ws, ["add", "."]);
    git(ws, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "change"]);
    expect(gitDiff(ws, base)).toContain("-one");
    expect(gitDiff(ws, base)).toContain("+two");
  });

  test("untracked 仍被纳入", () => {
    const ws = repoWithCommit();
    const base = gitHead(ws)!;
    writeFileSync(join(ws, "new.txt"), "42\n");
    expect(gitDiff(ws, base)).toContain("+++ b/new.txt");
  });

  test("不是 git 仓库：不崩", () => {
    const ws = mkdtempSync(join(tmpdir(), "dia-nogit-"));
    expect(gitHead(ws)).toBe(null);
    expect(() => gitDiff(ws, null)).not.toThrow();
  });
});

describe("verifier evidence 序列化", () => {
  test("object evidence 转成可读字符串，不出现 [object Object]", () => {
    const v = normalizeVerify({
      conclusion: "通过",
      evidence: [{ command: "grep -qx 42 answer.txt", exit_code: 0, output: "ok" }, "纯字符串"],
    });
    expect(v.evidence.length).toBe(2);
    expect(typeof v.evidence[0]).toBe("string");
    expect(v.evidence[0]).toContain("grep -qx 42");
    expect(v.evidence[0]).toContain("exit=0");
    expect(v.evidence.join("\n")).not.toContain("[object Object]");
  });

  test("未知结构的 object 退化为 JSON", () => {
    const v = normalizeVerify({ conclusion: "通过", evidence: [{ foo: "bar" }] });
    expect(v.evidence[0]).toContain('"foo":"bar"');
  });
});
