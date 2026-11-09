import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureJob } from "../src/observer.ts";

let root: string, jobRoot: string, home: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], extraEnv: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env as Record<string, string>,
    DIA_ROOT: root, DIA_JOB_ROOT: jobRoot, DIA_HOME: home,
    DIA_JOB_NO_LAUNCHD: "1", DIA_BIN: process.execPath, ...extraEnv,
  },
});
const json = (s: string) => JSON.parse(s);

const board = (interval = 300, at = new Date().toISOString()) => ({
  schema: 1, generated_at: at, interval_s: interval,
  open: 1, p0: 0, p1: 1, undelivered: 1, oldest_age_ms: 60_000,
  sessions: [{ id: "ses_b", open: 1, oldest_age_ms: 60_000 }], top: [], escalations: 0,
});

function writeBoard(b: any = board()) {
  const dir = join(root, "collab", "state");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const f = join(dir, "board.json");
  writeFileSync(f, JSON.stringify(b, null, 1), { mode: 0o600 });
  chmodSync(f, 0o600);
}
function writeRegistry(tasks: Record<string, any>) {
  mkdirSync(join(jobRoot, "tasks"), { recursive: true });
  writeFileSync(join(jobRoot, "tasks", "registry.json"), JSON.stringify({ tasks }));
}

const KEYS = ["DIA_ROOT", "DIA_JOB_ROOT", "DIA_HOME", "DIA_JOB_NO_LAUNCHD", "DIA_BIN"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-obsjob-"));
  jobRoot = mkdtempSync(join(tmpdir(), "dia-obsjob-j-"));
  home = mkdtempSync(join(tmpdir(), "dia-obsjob-h-"));
  process.env.DIA_ROOT = root;
  process.env.DIA_JOB_ROOT = jobRoot;
  process.env.DIA_HOME = home;
  process.env.DIA_JOB_NO_LAUNCHD = "1";
  process.env.DIA_BIN = process.execPath; // CI 的 PATH 里没有绝对 dia；显式给一个绝对可执行路径
});

afterAll(() => { /* temp dirs */ });

describe("interval 单一事实源 = job registry", () => {
  test("已注册 60s → ensureJob 校正为 300s（不再自锁）", () => {
    writeRegistry({ "collab-observe": { interval: "60", cmd: "dia collab observe", desc: "旧" } });
    expect(ensureJob()).toBeNull();
    const reg = JSON.parse(readFileSync(join(jobRoot, "tasks", "registry.json"), "utf8")).tasks["collab-observe"];
    expect(reg.interval).toBe("300");
    expect(reg.cmd).toContain("--interval 300");
  });

  test("board 写出 job 声明的 interval（而不是旧 board 值）", () => {
    writeRegistry({ "collab-observe": { interval: "120", cmd: "dia collab observe --interval 120" } });
    writeBoard(board(60));
    const r = run(["collab", "observe"]);
    expect(r.status).toBe(0);
    const b = JSON.parse(readFileSync(join(root, "collab", "state", "board.json"), "utf8"));
    expect(b.interval_s).toBe(120);
  });

  test("collab enable 顺手写一次 board（interval 立即对齐 job）", () => {
    writeRegistry({});
    const r = run(["collab", "enable"]);
    expect(r.status).toBe(0);
    const b = JSON.parse(readFileSync(join(root, "collab", "state", "board.json"), "utf8"));
    expect(b.interval_s).toBe(300);
  });

  test("非 60 倍数的 interval 归一为默认 300", () => {
    expect(ensureJob(90)).toBeNull();
    const reg = JSON.parse(readFileSync(join(jobRoot, "tasks", "registry.json"), "utf8")).tasks["collab-observe"];
    expect(reg.interval).toBe("300");
  });
});

describe("观察器定时：注册与 doctor 自检", () => {
  test("ensureJob 幂等注册 300s", () => {
    expect(ensureJob()).toBeNull();
    const reg = json(readFileSync(join(jobRoot, "tasks", "registry.json"), "utf8")).tasks;
    const key = Object.keys(reg).find((k) => k === "collab-observe" || k.endsWith(".collab-observe"));
    expect(key).toBeTruthy();
    expect(String(reg[key!].interval)).toBe("300");
    const cmd = String(reg[key!].cmd);
    expect(cmd).toContain("collab observe");
    // 有 dia 的机器写绝对路径（launchd PATH 不含 ~/.local/bin）；CI 无安装时退化为 'dia'
    expect(cmd).toMatch(/collab observe --interval 300$/);
    expect(ensureJob()).toBeNull(); // 第二次不再写
  });

  test("doctor：未注册 / 已注册新鲜 / interval 不一致 / 权限过宽", () => {
    writeBoard();
    let d = json(run(["doctor", "--json"]).stdout);
    let c = d.checks.find((x: any) => x.name === "collab.observer");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("未注册");

    writeRegistry({ "collab-observe": { interval: "300", cmd: "dia collab observe" } });
    d = json(run(["doctor", "--json"]).stdout);
    c = d.checks.find((x: any) => x.name === "collab.observer");
    expect(c.status).toBe("ok");

    writeBoard(board(60));
    d = json(run(["doctor", "--json"]).stdout);
    c = d.checks.find((x: any) => x.name === "collab.observer");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("interval 不一致");

    writeBoard(board(300));
    chmodSync(join(root, "collab", "state", "board.json"), 0o644);
    d = json(run(["doctor", "--json"]).stdout);
    c = d.checks.find((x: any) => x.name === "collab.observer");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("权限");
  });
});

describe("ensureJob 临时根保护", () => {
  test("DIA_ROOT 在临时目录且未显式 NO_LAUNCHD → 不注册", () => {
    const prev = process.env.DIA_JOB_NO_LAUNCHD;
    delete process.env.DIA_JOB_NO_LAUNCHD;
    const msg = ensureJob();
    expect(msg).toContain("临时数据根");
    if (prev === undefined) delete process.env.DIA_JOB_NO_LAUNCHD; else process.env.DIA_JOB_NO_LAUNCHD = prev;
  });
});
