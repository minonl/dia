import { afterAll, describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// team run --acp/--dsh 的确定性测试：用假 ACP 服务器（tests/fixtures/fake-acp.mjs），不花模型钱。
let home: string, data: string, cache: string, fakeBin: string, workspace: string, fakeLog: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const fakeSrc = join(import.meta.dir, "fixtures", "fake-acp.mjs");

const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env,
    DIA_HOME: home, DIA_DATA_DIR: data, DIA_CACHE_DIR: cache,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_LOG: fakeLog,
    ...env,
  },
});

function newTask(judge: string): string {
  const r = run(["task", "add", "团队演练", ...(judge ? ["--judge", judge] : []), "--json"]);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout).id;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-team-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-team-data-"));
  cache = mkdtempSync(join(tmpdir(), "dia-team-cache-"));
  fakeBin = mkdtempSync(join(tmpdir(), "dia-team-bin-"));
  for (const name of ["opencode", "dsh"]) {
    const p = join(fakeBin, name);
    copyFileSync(fakeSrc, p);
    chmodSync(p, 0o755);
  }
  fakeLog = join(mkdtempSync(join(tmpdir(), "dia-team-log-")), "sessions.jsonl");
  workspace = mkdtempSync(join(tmpdir(), "dia-team-ws-"));
  writeFileSync(join(workspace, "a.txt"), "hello\n");
  spawnSync("git", ["init", "-q"], { cwd: workspace });
});

const taskStatus = (id: string) => JSON.parse(run(["task", "list", "--json"]).stdout).find((t: any) => t.id === id)?.status;

afterAll(() => {
  for (const d of [home, data, cache, fakeBin, workspace, dirname(fakeLog)]) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("team run --acp（假 ACP 服）", () => {
  test("全流程：planner→builder→verifier→redteam → awaiting_acceptance + gate ok", () => {
    const id = newTask("a.txt 存在");
    const r = run(["team", "run", id, "--acp", "--workspace", workspace]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");

    const dir = join(data, "runs", id);
    expect(JSON.parse(readFileSync(join(dir, "verify.json"), "utf8")).conclusion).toBe("通过");
    expect(JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8")).findings).toEqual([]);
    expect(existsSync(join(dir, "packet.md"))).toBe(true);
    expect(existsSync(join(dir, "usage.json"))).toBe(true);
    // 快照真被用过（verifier/redteam 在副本里跑），且用完即删
    const log = readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const cwds = log.filter((e: any) => e.ev === "new").map((e: any) => String(e.cwd || ""));
    expect(cwds.some((c: string) => c.includes("verify-ws-0"))).toBe(true);
    expect(cwds.some((c: string) => c.includes("redteam-ws"))).toBe(true);
    expect(cwds).toContain(workspace); // planner/builder 在原 workspace；verifier/redteam 在副本
    expect(existsSync(join(dir, "verify-ws-0"))).toBe(false);
    expect(existsSync(join(dir, "redteam-ws"))).toBe(false);
    // 状态机真落到了台账（而不是只看 CLI 打印的字面量）
    expect(taskStatus(id)).toBe("awaiting_acceptance");

    expect(run(["team", "gate", id]).status).toBe(0);
    expect(run(["team", "accept", id]).status).toBe(0);
    expect(run(["task", "list", "--json"]).stdout).toContain('"accepted"');
  });

  test("验证不通过 → escalated（退出码 30），验收包写明升级", () => {
    const id = newTask("不可能满足的判据");
    const r = run(["team", "run", id, "--acp", "--workspace", workspace], { FAKE_VERIFY: "不通过" });
    expect(r.status).toBe(30);
    expect(r.stdout).toContain("escalated");
    const packet = readFileSync(join(data, "runs", id, "packet.md"), "utf8");
    expect(packet).toContain("已升级");
    expect(taskStatus(id)).toBe("escalated");
    expect(run(["team", "gate", id]).status).not.toBe(0);
  });

  test("没有判据 → E_TASK，不开跑", () => {
    const id = newTask("");
    const r = run(["team", "run", id, "--acp", "--workspace", workspace]);
    expect(r.stderr).toContain("E_TASK");
    expect(r.status).not.toBe(0);
  });
});

describe("team run --dsh（假 dsh）", () => {
  const configLog = () => readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e: any) => e.ev === "config");

  test("默认不向 profile 写死模型（用宿主配置）", () => {
    writeFileSync(fakeLog, "");
    const id = newTask("a.txt 存在");
    expect(run(["team", "run", id, "--dsh", "--workspace", workspace]).status).toBe(0);
    expect(configLog().filter((e: any) => e.id === "model")).toEqual([]);
  }, 30000);

  test("DIA_DSH_MODEL 显式覆盖才写 model", () => {
    writeFileSync(fakeLog, "");
    const id = newTask("a.txt 存在");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace], { DIA_DSH_MODEL: "example/deepseek-v4.1-flash" });
    expect(r.status).toBe(0);
    const models = configLog().filter((e: any) => e.id === "model");
    expect(models.length).toBeGreaterThan(0);
    expect(JSON.parse(models[0].value)).toEqual(["example", "deepseek-v4.1-flash"]);
  }, 30000);

  test("全流程 → awaiting_acceptance", () => {
    const id = newTask("a.txt 存在");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");
    expect(existsSync(join(data, "runs", id, "usage.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(data, "runs", id, "verify.json"), "utf8")).conclusion).toBe("通过");
  }, 30000);
});
