import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const run = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });

describe("paths：单一数据根", () => {
  test("不设任何 DIA_* 时落在 ~/.dia", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-paths-home-"));
    const r = run(["msg", "send", "ops", "--from", "me", "--kind", "notify", "--subject", "s"], {
      HOME: home,
      PATH: process.env.PATH || "/usr/bin:/bin",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".dia", "msg", "ops"))).toBe(true);
    expect(existsSync(join(home, ".local", "share", "dia"))).toBe(false);
  });

  test("DIA_ROOT 覆盖；DIA_MSG_ROOT 被忽略", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-paths-home2-"));
    const root = mkdtempSync(join(tmpdir(), "dia-paths-root-"));
    const ignored = mkdtempSync(join(tmpdir(), "dia-paths-ignore-"));
    const r = run(["msg", "send", "ops", "--from", "me", "--kind", "notify", "--subject", "s"], {
      HOME: home,
      DIA_ROOT: root,
      DIA_MSG_ROOT: ignored,
      PATH: process.env.PATH || "/usr/bin:/bin",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "msg", "ops"))).toBe(true);
    expect(existsSync(join(ignored, "ops"))).toBe(false);
  });
});

// 2026-11-16（Linux 实测）：XDG 此前只有零星支持（dia-job 认、dia 自己手拼 ~/.config）⇒
// 同一台机器上两边可能看到不同目录。统一到 paths.xdg* 后钉住行为。
describe("XDG：宿主约定目录统一解析", () => {
  const KEYS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
  const withEnv = (kv: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) { saved[k] = process.env[k]; if (kv[k] === undefined) delete process.env[k]; else process.env[k] = kv[k]; }
    try { fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };

  test("XDG_* 设置时优先", async () => {
    const paths = await import("../src/paths.ts");
    withEnv({ XDG_CONFIG_HOME: "/x/cfg", XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "/x/cache", XDG_STATE_HOME: "/x/state" }, () => {
      expect(paths.xdgConfig()).toBe("/x/cfg");
      expect(paths.xdgData()).toBe("/x/data");
      expect(paths.xdgCache()).toBe("/x/cache");
      expect(paths.xdgState()).toBe("/x/state");
    });
  });

  test("未设 XDG 时用规范默认值（数据根仍是 ~/.dia，不参与 XDG）", async () => {
    const paths = await import("../src/paths.ts");
    const { homedir } = await import("node:os");
    withEnv({}, () => {
      expect(paths.xdgConfig()).toBe(join(homedir(), ".config"));
      expect(paths.xdgData()).toBe(join(homedir(), ".local", "share"));
      expect(paths.xdgCache()).toBe(join(homedir(), ".cache"));
      expect(paths.xdgState()).toBe(join(homedir(), ".local", "state"));
      // 别的测试文件可能留下 DIA_ROOT / DIA_DATA_DIR 污染 ⇒ 两个都清掉再断言
      const savedRoot = process.env.DIA_ROOT, savedData = process.env.DIA_DATA_DIR;
      delete process.env.DIA_ROOT; delete process.env.DIA_DATA_DIR;
      try { expect(paths.diaHome()).toBe(join(homedir(), ".dia")); }
      finally {
        if (savedRoot) process.env.DIA_ROOT = savedRoot;
        if (savedData) process.env.DIA_DATA_DIR = savedData;
      }
    });
  });

  test("prices.json 跟 XDG_CONFIG_HOME 走（不再硬编码 ~/.config）", async () => {
    const pricing = await import("../src/pricing.ts");
    withEnv({ XDG_CONFIG_HOME: "/x/cfg" }, () => {
      const saved = process.env.DIA_PRICES_FILE; delete process.env.DIA_PRICES_FILE;
      try { expect(pricing.pricesFile()).toBe(join("/x/cfg", "dia", "prices.json")); }
      finally { if (saved) process.env.DIA_PRICES_FILE = saved; }
    });
  });
});
