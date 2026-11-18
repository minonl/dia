// cache.ts —— 缓存治理口径：cache 可再生、默认可删；本地独有内容（dirty/未推送/未知）默认跳过。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let cache: any;
let savedRoot: string | undefined;
let savedCacheDir: string | undefined;
let root: string;

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** 建一个干净的 git 缓存条目（模拟 persona clone 缓存：有 origin、提交已在远端）。 */
function makeEntry(key: string, opts: { dirty?: boolean; base?: string } = {}) {
  const base = opts.base ?? join(root, "cache", "src");
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

  const dir = join(base, key);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin, dir], { stdio: ["ignore", "pipe", "ignore"] });
  if (opts.dirty) writeFileSync(join(dir, "untracked.txt"), "local work\n");
  return dir;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dia-cache-"));
  savedRoot = process.env.DIA_ROOT;
  savedCacheDir = process.env.DIA_CACHE_DIR;
  process.env.DIA_ROOT = root;
  delete process.env.DIA_CACHE_DIR;
  cache = await import("../src/cache.ts");
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.DIA_ROOT;
  else process.env.DIA_ROOT = savedRoot;
  if (savedCacheDir === undefined) delete process.env.DIA_CACHE_DIR;
  else process.env.DIA_CACHE_DIR = savedCacheDir;
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

  test("root 下的杂项文件不会把整个 root 塌缩成一条（P0 回归）", () => {
    makeEntry("bbbbbbbbbbbb");
    writeFileSync(join(root, "cache", "src", ".DS_Store"), "junk");
    const rows = cache.list();
    expect(rows.map((r: any) => r.key)).toEqual(["src/bbbbbbbbbbbb"]);
  });

  test("DIA_CACHE_DIR 覆盖时扫描该目录", () => {
    const alt = join(root, "alt-cache");
    process.env.DIA_CACHE_DIR = alt;
    makeEntry("cccccccccccc", { base: alt });
    const rows = cache.list();
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe("src/cccccccccccc");
  });

  test("cacheKeyOfSource 与 persona/kit 的 clone 键一致（sha1 前 12 位）", () => {
    const a = cache.cacheKeyOfSource("git+https://example.com/a.git");
    const b = cache.cacheKeyOfSource("https://example.com/a.git");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("remote 地址脱敏：去掉 userinfo 与 query（防 --json 泄 token）", () => {
    expect(cache.sanitizeRemote("https://user:sekret@example.com/x.git")).toBe("https://***@example.com/x.git");
    expect(cache.sanitizeRemote("https://ghp_tok@example.com/x.git?token=abc")).toBe("https://***@example.com/x.git");
    expect(cache.sanitizeRemote("git@example.com:x.git")).toBe("git@example.com:x.git");
    expect(cache.sanitizeRemote(null)).toBe(null);
  });

  test("list 的 remote 已脱敏", () => {
    const dir = makeEntry("dddddddddddd");
    git(dir, ["remote", "set-url", "origin", "https://user:sekret@example.invalid/repo.git"]);
    const rows = cache.list();
    expect(JSON.stringify(rows)).not.toContain("sekret");
    expect(rows[0].git?.remote).toBe("https://***@example.invalid/repo.git");
  });
});

describe("cache gc：默认 dry-run、可再生才删", () => {
  test("dry-run 只报告不删", () => {
    const dir = makeEntry("eeeeeeeeeeee");
    const r = cache.gc();
    expect(r.removed.length).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  test("--apply 删除无引用的干净条目并统计释放空间", () => {
    const dir = makeEntry("ffffffffffff");
    const r = cache.gc({ apply: true });
    expect(r.removed.length).toBe(1);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("本地独有内容（未提交）默认跳过，--force 才删", () => {
    const dir = makeEntry("gggggggggggg", { dirty: true });
    const dry = cache.gc();
    expect(dry.removed.length).toBe(0);
    expect(dry.skipped[0].reason).toContain("本地独有内容");

    const forced = cache.gc({ apply: true, force: true });
    expect(forced.removed.length).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("git 状态无法判定（仓库损坏）→ 默认跳过，不误删", () => {
    const dir = makeEntry("hhhhhhhhhhhh", { dirty: true });
    rmSync(join(dir, ".git", "HEAD"), { force: true });
    const dry = cache.gc({ apply: true });
    expect(dry.removed.length).toBe(0);
    expect(dry.skipped[0].reason).toContain("无法判定");
    expect(existsSync(dir)).toBe(true);
  });

  test("被已安装 persona 引用（含 versions/<v> 新布局）→ 默认保留", () => {
    const key = cache.cacheKeyOfSource("git+https://example.com/p.git");
    makeEntry(key);
    const lockDir = join(root, "personas", "someone", "versions", "0.1.0");
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

  test("被已安装 kit 引用（kit.lock.source）→ 默认保留", () => {
    const key = cache.cacheKeyOfSource("https://example.com/k.git");
    makeEntry(key);
    const kitDir = join(root, "kits", "k", "0.1.0");
    mkdirSync(kitDir, { recursive: true });
    writeFileSync(join(kitDir, "kit.lock"), JSON.stringify({ id: "k", version: "0.1.0", source: "https://example.com/k.git" }));

    const r = cache.gc({ apply: true });
    expect(r.removed.length).toBe(0);
    expect(r.skipped[0].reason).toContain("kit:k@0.1.0");
  });

  test("--root 只清指定根", () => {
    makeEntry("iiiiiiiiiiii");
    const other = join(root, "cache", "ingest", "state");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "state.json"), "{}");

    const r = cache.gc({ apply: true, root: "src" });
    expect(r.removed.map((e: any) => e.key)).toEqual(["src/iiiiiiiiiiii"]);
    expect(existsSync(join(other, "state.json"))).toBe(true);
  });
});
