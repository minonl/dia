import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// TS 侧也必须读 ~/.config/dia-job/config（与 bash 同口径），否则 config-only 用户仍是两个真值源
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

function envFor(home: string, data: string, extra: Record<string, string> = {}) {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (["DIA_JOB_ROOT", "YAN_DATA_ROOT", "DIA_ROOT", "DIA_DATA_DIR", "DIA_JOB_CONFIG", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].includes(k)) continue;
    e[k] = v;
  }
  // ⚠️ 不设 DIA_ROOT/DIA_DATA_DIR：真实 env 的基目录按设计压过 config（这条另有测试）
  return { ...e, HOME: home, DIA_JOB_NO_LAUNCHD: "1", ...extra };
}

const runList = (home: string, _data: string, extra: Record<string, string> = {}) =>
  spawnSync("bun", [cli, "job", "list"], { encoding: "utf8", env: envFor(home, _data, extra) });

describe("TS 读 job config（0.1.4）", () => {
  test("config 里的 DIA_JOB_ROOT 生效", () => {
    const base = mkdtempSync(join(tmpdir(), "dia-cfg-ts-"));
    const home = join(base, "home"), data = join(base, "data");
    const job = join(home, ".dia", "job"), alt = join(base, "alt");
    mkdirSync(join(home, ".config", "dia-job"), { recursive: true });
    mkdirSync(job, { recursive: true });
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(home, ".config", "dia-job", "config"), `DIA_JOB_ROOT=${alt}\n`);
    const r = runList(home, data);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(alt);
  });

  test("config 的 ~ 会展开", () => {
    const base = mkdtempSync(join(tmpdir(), "dia-cfg-ts2-"));
    const home = join(base, "home"), data = join(base, "data");
    mkdirSync(join(home, ".config", "dia-job"), { recursive: true });
    mkdirSync(join(home, ".dia", "job"), { recursive: true });
    writeFileSync(join(home, ".config", "dia-job", "config"), "DIA_JOB_ROOT=~/tilde-alt\n");
    mkdirSync(join(home, "tilde-alt"), { recursive: true });
    const r = runList(home, data);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(join(home, "tilde-alt"));
  });

  test("真实 env DIA_JOB_ROOT 压过 config", () => {
    const base = mkdtempSync(join(tmpdir(), "dia-cfg-ts3-"));
    const home = join(base, "home"), data = join(base, "data");
    const alt = join(base, "alt"), explicit = join(base, "explicit");
    mkdirSync(join(home, ".config", "dia-job"), { recursive: true });
    mkdirSync(join(home, ".dia", "job"), { recursive: true });
    mkdirSync(alt, { recursive: true });
    mkdirSync(explicit, { recursive: true });
    writeFileSync(join(home, ".config", "dia-job", "config"), `DIA_JOB_ROOT=${alt}\n`);
    const r = runList(home, data, { DIA_JOB_ROOT: explicit });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(explicit);
    expect(r.stdout).not.toContain(alt);
  });
});
