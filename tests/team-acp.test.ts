import { afterAll, describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// team run --acp/--dsh 的确定性测试：用假 ACP 服务器（tests/fixtures/fake-acp.mjs），不花模型钱。
let home: string, data: string, cache: string, fakeBin: string, workspace: string, fakeLog: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const fakeSrc = join(import.meta.dir, "fixtures", "fake-acp.mjs");

// 剔除宿主 shell 可能导出的覆盖项（如开发者本机 DIA_DSH_MODEL），避免用例结果随环境漂移
const AMBIENT_OVERRIDES = ["DIA_DSH_MODEL", "DIA_ACP_TIMEOUT"];
const run = (args: string[], env: Record<string, string> = {}) => {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of AMBIENT_OVERRIDES) delete base[k];
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...base,
      DIA_HOME: home, DIA_DATA_DIR: data, DIA_CACHE_DIR: cache,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_LOG: fakeLog,
      ...env,
    } as Record<string, string>,
  });
};

let taskSeq = 0;
function newTask(judge: string): string {
  // title 决定 task id：每个用例必须唯一，否则多个用例共用一个 run 目录（CI 上并行/慢机暴露）
  const title = `团队演练-${++taskSeq}-${Date.now()}`;
  const r = run(["task", "add", title, ...(judge ? ["--judge", judge] : []), "--json"]);
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
    const id = newTask("test -f a.txt");
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
    // 快照路径不带 task id：角色无法反推 runs/<id>
    expect(cwds.every((c: string) => !c.includes(id))).toBe(true);
    expect(cwds.some((c: string) => c.includes("redteam-ws"))).toBe(true);
    expect(cwds).toContain(workspace); // planner/builder 在原 workspace；verifier/redteam 在副本
    expect(existsSync(join(dir, "verify-ws-0"))).toBe(false);
    expect(existsSync(join(dir, "redteam-ws"))).toBe(false);
    // 状态机真落到了台账（而不是只看 CLI 打印的字面量）
    expect(taskStatus(id)).toBe("awaiting_acceptance");
    // builder 的提示里必须要求产物进 git（redteam RT-1）
    const prompts = readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e: any) => e.ev === "prompt");
    expect(prompts.find((e: any) => e.role === "builder")?.text || "").toContain("git add");

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
    const id = newTask("test -f a.txt");
    expect(run(["team", "run", id, "--dsh", "--workspace", workspace]).status).toBe(0);
    expect(configLog().filter((e: any) => e.id === "model")).toEqual([]);
  }, 30000);

  test("DIA_DSH_MODEL 显式覆盖才写 model", () => {
    writeFileSync(fakeLog, "");
    const id = newTask("test -f a.txt");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace], { DIA_DSH_MODEL: "example/deepseek-v4.1-flash" });
    expect(r.status).toBe(0);
    const models = configLog().filter((e: any) => e.id === "model");
    expect(models.length).toBeGreaterThan(0);
    expect(JSON.parse(models[0].value)).toEqual(["example", "deepseek-v4.1-flash"]);
  }, 30000);

  test("全流程 → awaiting_acceptance", () => {
    const id = newTask("test -f a.txt");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");
    expect(existsSync(join(data, "runs", id, "usage.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(data, "runs", id, "verify.json"), "utf8")).conclusion).toBe("通过");
  }, 30000);
});


describe("team redteam high 自动修复", () => {
  test("第一轮 high → 回灌 builder 修 + 复检清零 → awaiting_acceptance；gate 对 high 判 fail", () => {
    const id = newTask("test -f a.txt");
    const r = run(["team", "run", id, "--acp", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "1", FAKE_JUDGE: "test -f a.txt" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");

    const redPath = join(data, "runs", id, "redteam.json");
    const red = JSON.parse(readFileSync(redPath, "utf8"));
    expect(red.findings).toEqual([]); // 第二轮已清零
    expect(red.round).toBe(2);
    expect(run(["team", "gate", id]).status).toBe(0);

    // 篡改出一条 high：gate 必须拦住
    writeFileSync(redPath, JSON.stringify({ findings: [{ severity: "high", trigger: "x", consequence: "y", repro: "z" }] }));
    const g = run(["team", "gate", id]);
    expect(g.status).toBe(30);
    expect(g.stdout).toContain("redteam high");
  });

  test("修复后 still high → escalated（不写 awaiting_acceptance）", () => {
    const id = newTask("test -f a.txt");
    const r = run(["team", "run", id, "--acp", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "always" });
    expect(r.status).toBe(30);
    const dir = join(data, "runs", id);
    const red = JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8"));
    expect(red.round).toBe(2);
    expect(red.findings.length).toBe(1);
    expect(red.findings[0].severity).toBe("high");
    const packet = readFileSync(join(dir, "packet.md"), "utf8");
    expect(packet).toContain("已升级");
    expect(packet).toContain("剩余 high：1");
    expect(taskStatus(id)).toBe("escalated");
    expect(run(["team", "gate", id]).status).not.toBe(0);
  });

  test("builder-fix 的真实改动写回 diff.patch（验收包不留修复前快照）", () => {
    const id = newTask("test -f a.txt");
    const name = "redteam-fix-acp.txt";
    const r = run(["team", "run", id, "--acp", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "1", FAKE_JUDGE: "test -f a.txt", FAKE_BUILDER_FIX: name });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");
    // 修复真的落到工作区
    expect(existsSync(join(workspace, name))).toBe(true);
    // 且必须出现在验收包的 diff.patch 里（人对它拍板）
    const diff = readFileSync(join(data, "runs", id, "diff.patch"), "utf8");
    expect(diff).toContain(name);
    expect(run(["team", "gate", id]).status).toBe(0);
  });

  test("修复后判据非 0 → escalated（判据现场重跑，不采信角色自述）", () => {
    const id = newTask("test -f missing.txt");
    const r = run(["team", "run", id, "--acp", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "1", FAKE_JUDGE: "test -f missing.txt" });
    expect(r.status).toBe(30);
    const dir = join(data, "runs", id);
    // 复检轮 high 已清零，升级只可能来自判据重跑
    expect(JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8")).findings).toEqual([]);
    const packet = readFileSync(join(dir, "packet.md"), "utf8");
    expect(packet).toContain("已升级");
    expect(packet).toContain("judge exit：1");
    expect(taskStatus(id)).toBe("escalated");
  });
});

describe("team run --dsh：redteam high 自动修复", () => {
  const rolesOf = (id: string) => JSON.parse(readFileSync(join(data, "runs", id, "usage.json"), "utf8")).by_role.map((r: any) => r.role);

  test("第一轮 high → builder 修 + redteam-2 复检清零 → awaiting_acceptance + gate ok", () => {
    const id = newTask("test -f a.txt");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");

    const dir = join(data, "runs", id);
    const red = JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8"));
    expect(red.findings).toEqual([]);
    expect(red.round).toBe(2);
    expect(readFileSync(join(dir, "packet.md"), "utf8")).toContain("反驳：0 条");
    // 用量记账覆盖修复链路的每一段（与 ACP 路径同名）
    expect(rolesOf(id)).toEqual(expect.arrayContaining(["builder-fix", "redteam-2"]));
    // 复检用的第二份快照用完即删
    expect(existsSync(join(dir, "redteam-ws-2"))).toBe(false);
    expect(taskStatus(id)).toBe("awaiting_acceptance");
    expect(run(["team", "gate", id]).status).toBe(0);
  }, 60000);

  test("builder-fix 的真实改动写回 diff.patch（dsh 路径同源）", () => {
    const id = newTask("test -f a.txt");
    const name = "redteam-fix-dsh.txt";
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "1", FAKE_BUILDER_FIX: name });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");
    expect(existsSync(join(workspace, name))).toBe(true);
    expect(readFileSync(join(data, "runs", id, "diff.patch"), "utf8")).toContain(name);
    expect(run(["team", "gate", id]).status).toBe(0);
  }, 60000);

  test("修复后 still high → escalated", () => {
    const id = newTask("test -f a.txt");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "always" });
    expect(r.status).toBe(30);
    const dir = join(data, "runs", id);
    const red = JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8"));
    expect(red.round).toBe(2);
    expect(red.findings.length).toBe(1);
    expect(readFileSync(join(dir, "packet.md"), "utf8")).toContain("剩余 high：1");
    expect(rolesOf(id)).toEqual(expect.arrayContaining(["builder-fix", "redteam-2"]));
    expect(taskStatus(id)).toBe("escalated");
  }, 60000);

  test("修复后判据非 0 → escalated", () => {
    const id = newTask("test -f missing.txt");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace], { FAKE_REDTEAM_HIGH: "1", FAKE_JUDGE: "test -f missing.txt" });
    expect(r.status).toBe(30);
    const dir = join(data, "runs", id);
    expect(JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8")).findings).toEqual([]);
    const packet = readFileSync(join(dir, "packet.md"), "utf8");
    expect(packet).toContain("已升级");
    expect(packet).toContain("judge exit：1");
    expect(taskStatus(id)).toBe("escalated");
  }, 60000);
});
