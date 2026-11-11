// tests/service-git-source.test.ts — `dia service add --from <git 源>` 的取回语义
//
// 全部用本地 `file://` bare 仓（不碰外网 / SSH 凭据），job 执行器注入替身（不装真调度）。
// 覆盖：isGitSource 判别、浅克隆 + 缓存、lock 生成、jobs 安装、clone 失败 → E_GIT_SOURCE 且不写 lock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "../src/service.ts";

const hasGit = (() => {
  try { return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0; } catch { return false; }
})();

const baseManifest = (id: string, over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "service",
  id,
  version: "0.1.0",
  entry: { cmd: "bin/worker" },
  lifecycle: { type: "periodic", interval: 300 },
  ...over,
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r;
};

/** 建一个「工作仓」（含可执行 entry）→ 推成 bare 仓，返回 `file://` URL 与工作仓路径。 */
function makeBareRepo(root: string, name: string): { url: string; work: string } {
  const work = join(root, "work", name);
  mkdirSync(join(work, "bin"), { recursive: true });
  writeFileSync(join(work, "bin", "worker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(work, "bin", "worker"), 0o755);
  writeFileSync(join(work, "dia.json"), JSON.stringify(baseManifest(name)));
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "test@example.com"]);
  git(work, ["config", "user.name", "test"]);
  git(work, ["add", "."]);
  git(work, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  const bare = join(root, "bare", `${name}.git`);
  mkdirSync(join(root, "bare"), { recursive: true });
  git(root, ["clone", "-q", "--bare", work, bare]);
  return { url: `file://${bare}`, work };
}

describe.skipIf(!hasGit)("isGitSource / normalizeGitSource", () => {
  test("识别 git 源，排除本地路径", () => {
    expect(s.isGitSource("git+ssh://git@github.com/a/b.git")).toBe(true);
    expect(s.isGitSource("git+https://git.leyantech.com/fed/x.git")).toBe(true);
    expect(s.isGitSource("git+http://host/x.git")).toBe(true);
    expect(s.isGitSource("git+file:///tmp/x.git")).toBe(true);
    expect(s.isGitSource("ssh://git@github.com/a/b.git")).toBe(true);
    expect(s.isGitSource("git@github.com:a/b.git")).toBe(true);
    expect(s.isGitSource("file:///tmp/x.git")).toBe(true);
    // 本地路径 / 冒号串 / 盘符一律不是 git 源
    for (const p of ["/local/path", "./rel", "../up", "a:b", "C:\\x", "C:/x", ""]) {
      expect(s.isGitSource(p)).toBe(false);
    }
  });

  test("归一化：去 git+ 前缀；scp-like → ssh://", () => {
    expect(s.normalizeGitSource("git+ssh://git@h/a/b.git")).toBe("ssh://git@h/a/b.git");
    expect(s.normalizeGitSource("git+file:///tmp/x.git")).toBe("file:///tmp/x.git");
    expect(s.normalizeGitSource("git@h:owner/repo.git")).toBe("ssh://git@h/owner/repo.git");
    expect(s.normalizeGitSource("ssh://git@h/a/b.git")).toBe("ssh://git@h/a/b.git");
  });
});

describe.skipIf(!hasGit)("add --from <git 源>（本地 bare 仓 + 注入 runner）", () => {
  let root: string;
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "svc-git-"));
    calls.length = 0;
    process.env.DIA_SERVICE_HOME = join(root, "services");
    process.env.DIA_JOB_ROOT = join(root, "job");
    process.env.DIA_JOB_ENTRY_DIR = join(root, "entry");
  });
  afterEach(() => {
    delete process.env.DIA_SERVICE_HOME;
    delete process.env.DIA_JOB_ROOT;
    delete process.env.DIA_JOB_ENTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("file:// 源：浅克隆到位、lock 生成、jobs 安装", () => {
    const { url } = makeBareRepo(root, "git-svc");
    const r = s.add({ dir: s.serviceDir("git-svc"), from: url, runner, backend: "cron" });

    expect(r).toMatchObject({ id: "git-svc", backend: "cron", dryRun: false, jobs: { service: "svc-git-svc" } });
    // 克隆产物到位（安装目录里能读到清单与 entry）
    expect(existsSync(join(r.dir, "dia.json"))).toBe(true);
    expect(existsSync(join(r.dir, "bin", "worker"))).toBe(true);
    // lock 生成，受管文件与清单一致
    const lock = s.readLockFile("git-svc");
    expect(lock.gen).toBe(r.gen);
    expect(Object.keys(lock.files).sort()).toEqual(["dia.json"]);
    // jobs 通过注入 runner 安装
    expect(calls.filter((c) => c[0] === "install").map((c) => c[1])).toEqual(["svc-git-svc"]);
    // 缓存目录被使用（非临时克隆）
    expect(existsSync(s.gitCacheRoot())).toBe(true);
  });

  test("git+file:// 形式同样识别并安装", () => {
    const { url } = makeBareRepo(root, "git-plus");
    const r = s.add({ dir: s.serviceDir("git-plus"), from: `git+${url}`, runner, backend: "cron" });
    expect(r.id).toBe("git-plus");
    expect(s.readLockFile("git-plus").dir).toBe(r.dir);
    expect(existsSync(join(r.dir, "dia.json"))).toBe(true);
  });

  test("--ref：浅克隆指定分支（--branch）", () => {
    const { url, work } = makeBareRepo(root, "git-ref");
    // 在 work 仓拉出 release 分支，版本 0.2.0，推回 bare
    git(work, ["checkout", "-q", "-b", "release"]);
    writeFileSync(join(work, "dia.json"), JSON.stringify({ ...baseManifest("git-ref"), version: "0.2.0" }));
    git(work, ["commit", "-q", "-am", "release 0.2.0"]);
    const bare = url.replace(/^file:\/\//, "");
    git(work, ["push", "-q", bare, "release"]);

    const r = s.add({ dir: s.serviceDir("git-ref"), from: url, ref: "release", runner, backend: "cron" });
    expect(r.version).toBe("0.2.0");
    expect(s.readLockFile("git-ref").version).toBe("0.2.0");
  });

  test("dry-run：不写 lock、不装 job；只清理本次新建的临时克隆", () => {
    const { url } = makeBareRepo(root, "git-dry");
    const r = s.add({ dir: s.serviceDir("git-dry"), from: url, runner, backend: "cron", dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(calls).toEqual([]);
    expect(() => s.readLockFile("git-dry")).toThrow(/E_NOT_INSTALLED/);
    // 临时克隆被清理；共享缓存未被 dry-run 写入 / 删除
    expect(existsSync(r.dir)).toBe(false);
    expect(existsSync(s.gitCacheRoot())).toBe(false);
  });

  test("clone 失败 → E_GIT_SOURCE（含 stderr 摘要），且不写 lock / 不装 job", () => {
    const missing = `file://${join(root, "nope", "missing.git")}`;
    let err: any;
    try {
      s.add({ dir: s.serviceDir("git-missing"), from: missing, runner, backend: "cron" });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/E_GIT_SOURCE/);
    expect(err.code).toBe("E_GIT_SOURCE");
    expect(calls).toEqual([]);
    expect(() => s.readLockFile("git-missing")).toThrow(/E_NOT_INSTALLED/);
    // 失败不留半装目录
    expect(existsSync(s.serviceDir("git-missing"))).toBe(false);
  });
});
