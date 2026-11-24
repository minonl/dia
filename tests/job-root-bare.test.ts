import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// #231：裸跑 `dia-job`（不经 dia 委派）必须与 dia CLI 用同一个根：
// env > .rootpin > legacy > 新默认（<DIA_ROOT>/job）。
const script = join(import.meta.dir, "..", "packages", "job", "bin", "dia-job");
// macOS 自带 bash 3.2（CI 用的就是它）：用系统 bash 才能抓到「CJK 紧邻 $var 被吞进变量名」这类问题
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "diajob-root-"));
  return { base, home: join(base, "home") };
}

function rootJson(home: string, extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    DIA_JOB_NO_LAUNCHD: "1",
    DIA_JOB_ROOT: undefined,
    YAN_DATA_ROOT: undefined,
    DIA_ROOT: undefined,
    DIA_DATA_DIR: undefined,
    XDG_DATA_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    DIA_JOB_CONFIG: undefined,
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(BASH, [script, "root", "--json"], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
  let parsed: any = null;
  try {
    parsed = JSON.parse((r.stdout || "").trim().split("\n").pop() || "null");
  } catch {
    parsed = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

describe("dia-job 根解析（#231）", () => {
  test("DIA_JOB_ROOT 显式优先于 pin 与 legacy", () => {
    const { home } = sandbox();
    mkdirSync(join(home, ".dia", "job"), { recursive: true });
    writeFileSync(join(home, ".dia", "job", ".rootpin"), JSON.stringify({ root: join(home, ".dia", "job") }));
    const r = rootJson(home, { DIA_JOB_ROOT: join(home, "explicit") });
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ root: join(home, "explicit"), source: "env" });
  });

  test("无 env 时读 .rootpin，裸跑不再落到 legacy", () => {
    const { home } = sandbox();
    const pinned = join(home, ".dia", "job");
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(pinned, ".rootpin"), JSON.stringify({ root: pinned }));
    // 即使 legacy 存在，pin 也要赢
    mkdirSync(join(home, ".local", "share", "dia-job"), { recursive: true });
    const r = rootJson(home);
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ root: pinned, source: "pin" });
  });

  test("pin 指向已删除的根 → 忽略 pin 并 warn", () => {
    const { home } = sandbox();
    const dir = join(home, ".dia", "job");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".rootpin"), JSON.stringify({ root: join(home, "gone") }));
    const r = rootJson(home);
    expect(r.status).toBe(0);
    expect(r.parsed?.source).toBe("next");
    expect(r.parsed?.root).toBe(dir);
    expect(r.stderr).toContain("rootpin");
  });

  test("无 pin 无 legacy → 默认 <DIA_ROOT>/job", () => {
    const { home } = sandbox();
    const r = rootJson(home);
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ root: join(home, ".dia", "job"), source: "next" });
  });

  test("DIA_ROOT 覆盖默认基目录（与 src/paths.ts 口径一致）", () => {
    const { base, home } = sandbox();
    const diaRoot = join(base, "custom-dia");
    const r = rootJson(home, { DIA_ROOT: diaRoot });
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ root: join(diaRoot, "job"), source: "next" });
  });

  test("legacy 仅在 next 不存在时兜底，并给出迁移提示", () => {
    const { home } = sandbox();
    const legacy = join(home, ".local", "share", "dia-job");
    mkdirSync(legacy, { recursive: true });
    const r = rootJson(home);
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ root: legacy, source: "legacy" });
    expect(r.stderr).toContain("dia job migrate");
  });
});


describe("config（~/.config/dia-job/config）与根解析（2026-11-24）", () => {
  const cfgFor = (home: string, root: string) => {
    const dir = join(home, ".config", "dia-job");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "config");
    writeFileSync(f, `DIA_JOB_ROOT=${root}\n`);
    return f;
  };

  test("只有 config → source=config", () => {
    const { home } = sandbox();
    const root = join(home, "cfg-root");
    mkdirSync(root, { recursive: true });
    cfgFor(home, root);
    const r = rootJson(home);
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ root, source: "config" });
  });

  test("有效 pin 压过 config，并给一行 warn", () => {
    const { home } = sandbox();
    const pinned = join(home, ".dia", "job");
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(pinned, ".rootpin"), JSON.stringify({ root: pinned }));
    cfgFor(home, join(home, "cfg-root"));
    const r = rootJson(home);
    expect(r.parsed).toEqual({ root: pinned, source: "pin" });
    expect(r.stderr).toContain("与 .rootpin 不一致");
  });

  test("真实 env 的 DIA_ROOT 压过 config（防沙箱逃逸）", () => {
    const { base, home } = sandbox();
    cfgFor(home, join(home, "cfg-root"));
    const diaRoot = join(base, "sandbox");
    const r = rootJson(home, { DIA_ROOT: diaRoot });
    expect(r.parsed).toEqual({ root: join(diaRoot, "job"), source: "next" });
    expect(r.stderr).toContain("被 DIA_ROOT/DIA_DATA_DIR 覆盖");
  });

  test("坏 pin → 回落 config", () => {
    const { home } = sandbox();
    const dir = join(home, ".dia", "job");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".rootpin"), JSON.stringify({ root: join(home, "gone") }));
    const cfgRoot = join(home, "cfg-root");
    mkdirSync(cfgRoot, { recursive: true });
    cfgFor(home, cfgRoot);
    const r = rootJson(home);
    expect(r.parsed).toEqual({ root: cfgRoot, source: "config" });
    expect(r.stderr).toContain("rootpin");
  });

  test("config 里的 ~ 会展开到 HOME（不建字面 ~ 目录）", () => {
    const { home } = sandbox();
    const f = cfgFor(home, "~/tilderoot");
    const r = rootJson(home);
    expect(r.parsed?.root).toBe(join(home, "tilderoot"));
    expect(existsSync(join(home, "tilderoot"))).toBe(true);
    expect(readFileSync(f, "utf8")).toContain("~/tilderoot");
  });

  test("E_JOB_ROOT_EPHEMERAL：config 注入的临时根不算显式（install rc=9），显式 env 才放行", () => {
    const { base, home } = sandbox();
    const tmpRoot = join(base, "tmpjob");
    cfgFor(home, tmpRoot);
    // ⚠️ spawnSync 会把 undefined 值 String() 成 "undefined"（不是删除）→ 必须显式剔除
    const cleanEnv = (extra: Record<string, string>) => {
      const e: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !["DIA_JOB_ROOT", "YAN_DATA_ROOT", "DIA_ROOT", "DIA_DATA_DIR", "DIA_JOB_CONFIG", "DIA_JOB_NO_LAUNCHD", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].includes(k)) e[k] = v;
      }
      return { ...e, HOME: home, ...extra };
    };
    const cfgOnly = spawnSync(BASH, [script, "install", "t1", "--cmd", "true", "--calendar", "09:00"], {
      encoding: "utf8",
      env: cleanEnv({}),
    });
    expect(cfgOnly.status).toBe(9);
    expect(cfgOnly.stderr).toContain("E_JOB_ROOT_EPHEMERAL");

    const explicit = spawnSync(BASH, [script, "install", "t2", "--cmd", "true", "--calendar", "09:00"], {
      encoding: "utf8",
      env: cleanEnv({ DIA_JOB_ROOT: tmpRoot, DIA_JOB_NO_LAUNCHD: "1" }),
    });
    expect(explicit.status).not.toBe(9);
  });
});
