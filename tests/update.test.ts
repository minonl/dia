import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "dia-npmbin-"));
  writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "$1 $2 $3" = "view @minonl/dia dist-tags" ]; then
  echo '[{"latest":"9.9.9","next":"9.9.9-beta.1"}]'
  exit 0
fi
if [ "$1" = "i" ] && [ -n "\${FAKE_NPM_INSTALL:-}" ]; then echo "installed" > "\${FAKE_NPM_MARK:-/tmp/dia-npm-installed}"; fi
echo "install $@"
`);
  chmodSync(join(bin, "npm"), 0o755);
});

const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
});

describe("dia update", () => {
  test("--check 发现新版本（exit 1）并打印 latest/next", () => {
    const r = run(["update", "--check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("latest 9.9.9");
  });

  test("version 从 package.json 读取", () => {
    const r = run(["version"]);
    expect(r.stdout.trim()).toMatch(/^dia \d+\.\d+\.\d+/);
  });
});


describe("dia update 按安装方式分流", () => {
  test("脚本安装：只给升级指引，不调 npm i", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-install-script-"));
    const mark = join(mkdtempSync(join(tmpdir(), "dia-mark-")), "npm-i");
    const r = run(["update"], { DIA_INSTALL_DIR: dir, FAKE_NPM_MARK: mark });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("脚本安装");
    expect(r.stdout).toContain("bash install.sh");
    expect(existsSync(mark)).toBe(false);
  });

  test("npm 安装：调用 npm i -g", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "dia-install-npm-")), "node_modules", "@minonl", "dia");
    mkdirSync(dir, { recursive: true });
    const mark = join(mkdtempSync(join(tmpdir(), "dia-mark-")), "npm-i");
    const r = run(["update"], { DIA_INSTALL_DIR: dir, FAKE_NPM_INSTALL: "1", FAKE_NPM_MARK: mark });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("npm 全局包");
    expect(existsSync(mark)).toBe(true);
  });
});
