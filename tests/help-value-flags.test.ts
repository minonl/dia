// VALUE_FLAGS 的「每一项都要有代码依据」审计（2026-11-19 对抗评审后新增）。
//
// 背景：`--force-with-lease` 零消费方却被收进白名单 ⇒ `dia cache gc --apply --force-with-lease --help`
// 把 --help 当值吞掉 ⇒ **真的删了 cache**。方向与 #228 的目标相反，故用测试把清单钉在代码事实上。
//
// 两个方向的不对称（help.ts 顶部也写了）：
//   误收（把真 --help 当值）⇒ 命令执行 ⇒ 危险
//   漏收（把值当 --help）  ⇒ 只显示帮助 ⇒ 安全
// ⇒ 本文件的判据：
//   ① 每个 flag 必须能在**经过 helpGate 的代码**里找到取值点（TS 的 flag()/flags()，或 job 侧 bash 的 `--x) v="$2"`）；
//   ② 只被 `dia wt` 消费的不算（wt 不走本 gate，自己早退）；
//   ③ 除 4 个「值可能真是 --help」的自由文本 flag 外，`--<flag> --help` 必须判为「请求帮助」。

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  VALUE_FLAGS,
  HELP_AS_VALUE_FLAGS,
  EXCLUDED_OPTIONAL_VALUE,
  helpRequested,
} from "../packages/cli/src/help.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "packages", "cli", "src", "index.ts");
const SKIP_DIR = new Set(["node_modules", "dist", ".git", ".worktrees", "experiments", "tests"]);

/** 收集「经过 helpGate 的实现代码」：排除 tests/、dist/、node_modules/ 与 packages/wt（不走本 gate）。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (relative(ROOT, p).startsWith("packages/wt/")) continue;
      if (/\.(ts|sh|bash)$/.test(e.name) || /\/bin\/[^./]+$/.test(p)) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

/** 某 flag 的取值点证据（返回 file:line 列表；空 = 无依据）。 */
function evidenceFor(flag: string): string[] {
  const hits: string[] = [];
  const quoted = `"${flag}"`;
  for (const f of sourceFiles()) {
    const rel = relative(ROOT, f);
    if (rel === "packages/cli/src/help.ts") continue;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      let ok = false;
      // TS：flag(args, "--x") / flags(args, "--x")
      if (/\bflags?\(/.test(line) && line.includes(quoted)) ok = true;
      // bash：`--x) v="$2"` / `--x) v="${2:-}"`（job 侧）或 `--x) shift 2`（值位）
      else if (new RegExp(`^\\s*${flag}\\)`).test(line) && /\$\{?2/.test(line)) ok = true;
      // 逐 token 取值：`a === "--x" && argv[i + 1]`
      else if (line.includes(quoted) && /\[i \+ 1\]/.test(line)) ok = true;
      // wb-cli / wb-track-cli / route-cli 的「取值 flag 白名单」（positional 跳过 = 消费值）
      else if (/^\s*"--[a-z0-9-]+",/.test(line) && /(wb-cli|wb-track-cli|route-cli)\.ts$/.test(rel) && line.includes(quoted)) ok = true;
      if (ok) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

describe("VALUE_FLAGS：每一项都有真实取值点", () => {
  for (const flag of [...VALUE_FLAGS].sort()) {
    test(`${flag} 有消费方`, () => {
      const ev = evidenceFor(flag);
      expect(ev.length).toBeGreaterThan(0);
    });
  }

  test("只被 dia wt 消费的 flag 一律不收（wt 不走本 gate）", () => {
    // 评审点名：--base / --protect 仅 packages/wt/bin/dia-wt 使用
    for (const f of ["--base", "--protect"]) {
      expect(VALUE_FLAGS.has(f)).toBe(false);
    }
  });

  test("零消费方的 flag 不得收（--force-with-lease 曾导致真删数据）", () => {
    expect(VALUE_FLAGS.has("--force-with-lease")).toBe(false);
    expect(evidenceFor("--force-with-lease")).toEqual([]);
  });
});

describe("VALUE_FLAGS：误收方向已被 HELP_AS_VALUE_FLAGS 关掉", () => {
  test("自由文本例外只有 4 个，且都在 VALUE_FLAGS 里", () => {
    expect([...HELP_AS_VALUE_FLAGS].sort()).toEqual(["--body", "--desc", "--reason", "--subject"]);
    for (const f of HELP_AS_VALUE_FLAGS) expect(VALUE_FLAGS.has(f)).toBe(true);
  });

  for (const flag of [...VALUE_FLAGS].sort()) {
    if (HELP_AS_VALUE_FLAGS.has(flag)) continue;
    test(`${flag} --help 判为「请求帮助」（⇒ 不会执行）`, () => {
      expect(helpRequested([flag, "--help"])).toBe(true);
      expect(helpRequested(["gc", "--apply", flag, "--help"])).toBe(true);
    });
  }

  test("自由文本例外保持值位语义（`--body --help` 是正文）", () => {
    expect(helpRequested(["--body", "--help"])).toBe(false);
    expect(helpRequested(["--subject", "s", "--body", "--help", "--json"])).toBe(false);
  });
});

describe("「存在性开关 + 可选值」的 flag：刻意不收 + 已登记", () => {
  test("--due / --export-html / --next 不在 VALUE_FLAGS", () => {
    for (const f of ["--due", "--export-html", "--next"]) {
      expect(VALUE_FLAGS.has(f)).toBe(false);
      expect(EXCLUDED_OPTIONAL_VALUE.has(f)).toBe(true);
    }
  });

  test("登记表里的 flag 一个都不许混进 VALUE_FLAGS", () => {
    for (const f of EXCLUDED_OPTIONAL_VALUE) expect(VALUE_FLAGS.has(f)).toBe(false);
  });

  test("`--due --help` / `--next --help` 判为请求帮助", () => {
    expect(helpRequested(["--due", "--help"])).toBe(true);
    expect(helpRequested(["--next", "--help"])).toBe(true);
    expect(helpRequested(["--export-html", "--help"])).toBe(true);
  });
});

// ── 真实 CLI：白名单里的 flag 放在破坏性命令后面，仍不得执行 ─────────────────
describe("真实 CLI：cache gc --apply --<flag> --help 零删除", () => {
  const HOST_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "USER", "LOGNAME", "TMPDIR", "TZ"];

  const SANDBOXES: string[] = [];
  afterAll(() => {
    for (const d of SANDBOXES) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  });

  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), "dia-vf-"));
    SANDBOXES.push(dir);
    const env: Record<string, string> = {};
    for (const k of HOST_ENV) if (process.env[k] !== undefined) env[k] = String(process.env[k]);
    env.HOME = join(dir, "home");
    env.DIA_ROOT = join(dir, "data");
    env.DIA_JOB_ROOT = join(dir, "job");
    env.DIA_SESSION_ID = "ses_vf_test";
    env.NO_COLOR = "1";
    env.BUN_INSTALL = join(tmpdir(), "dia-help-bun-install");
    for (const d of [env.HOME, env.DIA_ROOT, env.DIA_JOB_ROOT, join(env.DIA_JOB_ROOT, "tasks")]) mkdirSync(d, { recursive: true });
    return { dir, env };
  }

  // 抽样（覆盖不同类型：id / 路径 / 数字 / env / session），全量与全 122 项等价的判据在上面单测里
  for (const flag of ["--id", "--item", "--root", "--days", "--env", "--session", "--timeout", "--workspace"]) {
    test(`cache gc --apply ${flag} --help 不删文件`, () => {
      const sb = sandbox();
      const victim = join(sb.dir, "data", "cache", "src", "victim");
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, "f"), "z");
      const r = spawnSync("bun", [CLI, "cache", "gc", "--apply", flag, "--help"], {
        cwd: ROOT, env: sb.env, encoding: "utf8", timeout: 120_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("dia cache gc");
      expect(r.stdout).not.toContain("已删除");
      expect(existsSync(join(victim, "f"))).toBe(true);
    });
  }
});
