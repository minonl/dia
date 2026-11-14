import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureJob, ensureUpkeepJob } from "../src/observer.ts";

// 2026-11-13 事故回归：registry 说「已装」，但 crontab 条目被抹掉 →
// 旧逻辑在 Linux 上直接跳过重装，enable 报成功、board 永远陈旧。
let root: string, jobRoot: string, home: string, store: string, fakeCron: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["DIA_ROOT", "DIA_JOB_ROOT", "DIA_HOME", "DIA_BIN", "DIA_JOB_NO_LAUNCHD",
  "DIA_JOB_ALLOW_EPHEMERAL", "DIA_JOB_CRONTAB_BIN", "FAKE_CRON_STORE"] as const;

const writeRegistry = (tasks: Record<string, any>) => {
  mkdirSync(join(jobRoot, "tasks"), { recursive: true });
  writeFileSync(join(jobRoot, "tasks", "registry.json"), JSON.stringify({ tasks }));
};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "dia-carrier-"));
  jobRoot = mkdtempSync(join(tmpdir(), "dia-carrier-j-"));
  home = mkdtempSync(join(tmpdir(), "dia-carrier-h-"));
  store = join(mkdtempSync(join(tmpdir(), "dia-carrier-c-")), "crontab.txt");
  fakeCron = join(home, "fake-crontab");
  writeFileSync(fakeCron, `#!/usr/bin/env bash\nstore="$FAKE_CRON_STORE"\ncase "\${1:-}" in\n  -l) [ -f "$store" ] && cat "$store"; exit 0 ;;\n  -) cat > "$store"; exit 0 ;;\n  *) exit 2 ;;\nesac\n`);
  chmodSync(fakeCron, 0o755);
  writeFileSync(store, "");

  process.env.DIA_ROOT = root;
  process.env.DIA_JOB_ROOT = jobRoot;
  process.env.DIA_HOME = home;
  process.env.DIA_BIN = process.execPath;
  process.env.DIA_JOB_NO_LAUNCHD = "";
  process.env.DIA_JOB_ALLOW_EPHEMERAL = "1";
  process.env.DIA_JOB_CRONTAB_BIN = fakeCron;
  process.env.FAKE_CRON_STORE = store;
});

afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const cron = () => (existsSync(store) ? readFileSync(store, "utf8") : "");

const registryEntry = (cmd: string) => ({
  "collab-observe": {
    type: "periodic", backend: "cron", label: "local.dia-job-collab-observe",
    cmd, interval: "300", desc: "t", log: join(jobRoot, "tasks", "collab-observe.log"),
  },
});

describe("载体缺失必须重装（crontab 被外部抹掉）", () => {
  test("registry 在、条目不在 → ensureJob 重新写入 crontab", () => {
    writeRegistry(registryEntry(`'${process.execPath}' collab observe --interval 300`));
    expect(cron()).toBe("");
    expect(ensureJob()).toBeNull();
    expect(cron()).toContain("# dia-job:collab-observe");
  });

  test("条目被抹掉后再次 ensureJob → 自愈", () => {
    writeRegistry(registryEntry(`'${process.execPath}' collab observe --interval 300`));
    expect(ensureJob()).toBeNull();
    writeFileSync(store, ""); // 模拟 crontab 被别的工具重写
    expect(ensureJob()).toBeNull();
    expect(cron()).toContain("# dia-job:collab-observe");
  });

  test("载体在位 → 幂等，不再重写", () => {
    writeRegistry(registryEntry(`'${process.execPath}' collab observe --interval 300`));
    expect(ensureJob()).toBeNull();
    const before = statSync(store).mtimeMs;
    expect(ensureJob()).toBeNull();
    expect(statSync(store).mtimeMs).toBe(before);
  });

  test("msg-upkeep 也按载体判定", () => {
    mkdirSync(join(jobRoot, "tasks"), { recursive: true });
    writeRegistry({
      "msg-upkeep": {
        type: "periodic", backend: "cron", label: "local.dia-job-msg-upkeep",
        cmd: `'${process.execPath}' msg upkeep`, interval: "300", desc: "t", log: join(jobRoot, "tasks", "msg-upkeep.log"),
      },
    });
    expect(ensureUpkeepJob()).toBeNull();
    expect(cron()).toContain("# dia-job:msg-upkeep");
  });
});
