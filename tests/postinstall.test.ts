import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// postinstall 自举 / 数据根迁移：幂等、零失败、不碰真机 HOME
let home: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
// 清掉前序测试可能泄漏的覆盖变量（同一进程内 bun 会共享 process.env）
const cleanEnv = (env: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = {
    ...process.env,
    DIA_HOME: home, DIA_DATA_DIR: home, DIA_CACHE_DIR: join(home, "cache"),
  };
  for (const k of ["DIA_STATE_DIR", "DIA_INSTALL_DIR", "DIA_HOME_INSTALL", "DIA_KIT_LOCK_MS", "DIA_MSG_AUTO", "DIA_NO_POSTINSTALL"]) delete e[k];
  return { ...e, ...env } as Record<string, string>;
};
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bun", [cli, ...args], { encoding: "utf8", env: cleanEnv(env) });

beforeAll(() => { home = mkdtempSync(join(tmpdir(), "dia-post-")); });

describe("dia postinstall", () => {
  test("装配内置 kit + 写自举戳，重复跑幂等", () => {
    const r1 = run(["postinstall"]);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("kit=dia-msg@");
    const stamp = JSON.parse(readFileSync(join(home, "state/bootstrap.json"), "utf8"));
    expect(stamp.kit).toBe("dia-msg");
    const r2 = run(["postinstall"]);
    expect(r2.status).toBe(0);
  });

  test("--quiet 无输出且退出 0", () => {
    const r = run(["postinstall", "--quiet"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("数据根不可写也不失败（npm install 不能被自举拖垮）", () => {
    const ro = mkdtempSync(join(tmpdir(), "dia-post-ro-"));
    mkdirSync(join(ro, "state"), { recursive: true });
    const r = run(["postinstall", "--quiet"], { DIA_HOME: ro, DIA_DATA_DIR: ro });
    expect(r.status).toBe(0);
  });

  test("scripts/postinstall.mjs 在非全局/CI 下直接跳过（不写盘）", () => {
    const h = mkdtempSync(join(tmpdir(), "dia-post-skip-"));
    const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "scripts", "postinstall.mjs")], {
      encoding: "utf8",
      env: { ...process.env, DIA_HOME: h, DIA_DATA_DIR: h, CI: "1" },
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(h, "kits"))).toBe(false);
  });
});

describe("dia migrate data", () => {
  test("搬数据子目录，目标已存在则合并；--dry-run 不动盘", () => {
    const from = mkdtempSync(join(tmpdir(), "dia-mig-from-"));
    const to = mkdtempSync(join(tmpdir(), "dia-mig-to-"));
    mkdirSync(join(from, "personas/dabo"), { recursive: true });
    mkdirSync(join(from, "msg"), { recursive: true });
    mkdirSync(join(to, "msg"), { recursive: true });
    writeFileSync(join(from, "msg/a.json"), "{}");
    writeFileSync(join(to, "msg/b.json"), "{}");

    const dry = run(["migrate", "data", "--from", from, "--dry-run"], { DIA_HOME: to, DIA_DATA_DIR: to });
    expect(dry.status).toBe(0);
    expect(existsSync(join(from, "msg/a.json"))).toBe(true);

    const r = run(["migrate", "data", "--from", from], { DIA_HOME: to, DIA_DATA_DIR: to });
    expect(r.status).toBe(0);
    expect(existsSync(join(to, "personas/dabo"))).toBe(true);
    expect(existsSync(join(to, "msg/a.json"))).toBe(true);
    expect(existsSync(join(to, "msg/b.json"))).toBe(true);
    expect(existsSync(join(from, "msg/a.json"))).toBe(false);
  });

  test("旧根不存在 → 无需迁移，exit 0", () => {
    const r = run(["migrate", "data", "--from", join(home, "nope")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("无需迁移");
  });
});
