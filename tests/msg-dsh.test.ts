import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let home: string, bin: string, dshHome: string;
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, HOME: home, DSH_HOME: dshHome, PATH: `${bin}:${process.env.PATH}`, ...env },
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "dia-dsh-"));
  home = join(base, "home"); dshHome = join(base, "dsh"); bin = join(base, "bin");
  mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  mkdirSync(join(dshHome, "profiles", "demo"), { recursive: true });
  // fake dsh：plugin add / --dump-config 都成功
  const sh = join(bin, "dsh");
  writeFileSync(sh, "#!/bin/sh\nexit 0\n");
  chmodSync(sh, 0o755);
});

describe("dia msg dsh install", () => {
  test("无 --profile → 拒绝（不猜默认 profile）", () => {
    const r = run(["msg", "dsh", "check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("需要 --profile");
  });

  test("dry-run 只打印计划，不改 profile", () => {
    const r = run(["msg", "dsh", "install", "--profile", "demo", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("计划");
    expect(existsSync(join(dshHome, "profiles", "demo", "cordis.patch.yml"))).toBe(false);
  });

  test("install 复制插件 + 追加 patch（幂等）", () => {
    writeFileSync(join(dshHome, "profiles", "demo", "cordis.patch.yml"), "- insert: []\n");
    const r = run(["msg", "dsh", "install", "--profile", "demo"]);
    expect(r.status).toBe(0);
    const patch = readFileSync(join(dshHome, "profiles", "demo", "cordis.patch.yml"), "utf8");
    expect(patch).toContain("id: dia-inbox");
    expect(existsSync(join(dshHome, "profiles", "demo", "plugins", "dia-inbox", "index.js"))).toBe(true);
    const again = run(["msg", "dsh", "install", "--profile", "demo"]);
    expect(again.status).toBe(0);
    const patch2 = readFileSync(join(dshHome, "profiles", "demo", "cordis.patch.yml"), "utf8");
    expect(patch2.match(/id: dia-inbox/g)?.length).toBe(1);
  });
});
