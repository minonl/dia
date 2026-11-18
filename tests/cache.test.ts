// cache.ts —— 缓存治理口径：cache 可再生、默认可删；本地独有内容（dirty/未推送）默认跳过。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let cache: any;
let savedRoot: string | undefined;
let root: string;

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** 建一个干净的 git 缓存条目（模拟 persona clone 缓存：有 origin、提交已在远端）。 */
function makeEntry(key: string, opts: { dirty?: boolean } = {}) {
  const origin = join(root, "origins", `${key}.git`);
  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "--quiet", "-b", "main"]);
  const seed = join(root, "seed", key);
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(seed, "README.md"), "x\n");
  git(seed, ["add", "."]);
  git(seed, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "init"]);
  git(seed, ["push", "--quiet", origin, "HEAD:refs/heads/main"]);

  const dir = join(root, "cache", "src", key);
  mkdirSync(join(root, "cache", "src"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin, dir], { stdio: ["ignore", "pipe", "ignore"] });
  if (opts.dirty) writeFileSync(join(dir, "untracked.txt"), "local work\n");
  return dir;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dia-cache-"));
  savedRoot = process.env.DIA_ROOT;
  process.env.DIA_ROOT = root;
  cache = await import("../src/cache.ts");
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.DIA_ROOT;
  else process.env.DIA_ROOT = savedRoot;
});

describe("cache 列目录", () => {
  test("空数据根 → 空列表", () => {
    expect(cache.list()).toEqual([]);
  });

  test("识别 src/<key> 条目、体积与 git 状态", () => {
    makeEntry("aaaaaaaaaaaa");
    const rows = cache.list();
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe("src/aaaaaaaaaaaa");
    expect(rows[0].bytes).toBeGreaterThan(0);
    expect(rows[0].git?.head).toBeTruthy();
    expect(rows[0].localOnly).toBe(false);
  });

  test("cacheKeyOfSource 与 persona/kit 的 clone 键一致（sha1 前 12 位）", () => {
    const a = cache.cacheKeyOfSource("git+https://example.com/a.git");
    const b = cache.cacheKeyOfSource("https://example.com/a.git");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("cache gc：默认 dry-run、可再生才删", () => {
  test("dry-run 只报告不删", () => {
    const dir = makeEntry("bbbbbbbbbbbb");
    const r = cache.gc();
    expect(r.removed.length).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  test("--apply 删除无引用的干净条目并统计释放空间", () => {
    const dir = makeEntry("cccccccccccc");
    const r = cache.gc({ apply: true });
    expect(r.removed.length).toBe(1);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("本地独有内容（未提交）默认跳过，--force 才删", () => {
    const dir = makeEntry("dddddddddddd", { dirty: true });
    const dry = cache.gc();
    expect(dry.removed.length).toBe(0);
    expect(dry.skipped[0].reason).toContain("本地独有内容");

    const forced = cache.gc({ apply: true, force: true });
    expect(forced.removed.length).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("被已安装 persona 引用的条目默认保留，--referenced 可删", () => {
    const key = cache.cacheKeyOfSource("git+https://example.com/p.git");
    makeEntry(key);
    const lockDir = join(root, "personas", "someone", "0.1.0");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "dia.lock"), JSON.stringify({ id: "someone", version: "0.1.0", source: "git+https://example.com/p.git" }));

    const dry = cache.gc({ apply: true });
    expect(dry.removed.length).toBe(0);
    expect(dry.skipped[0].reason).toContain("被引用");
    expect(existsSync(join(root, "cache", "src", key))).toBe(true);

    const forced = cache.gc({ apply: true, referenced: true });
    expect(forced.removed.length).toBe(1);
    expect(readdirSync(join(root, "cache", "src")).length).toBe(0);
  });
});
