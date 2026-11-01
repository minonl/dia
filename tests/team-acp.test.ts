import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// team run --acp/--dsh 的确定性测试：用假 ACP 服务器（tests/fixtures/fake-acp.mjs），不花模型钱。
let home: string, data: string, cache: string, fakeBin: string, workspace: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const fakeSrc = join(import.meta.dir, "fixtures", "fake-acp.mjs");

const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env,
    DIA_HOME: home, DIA_DATA_DIR: data, DIA_CACHE_DIR: cache,
    PATH: `${fakeBin}:${process.env.PATH}`,
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
  workspace = mkdtempSync(join(tmpdir(), "dia-team-ws-"));
  writeFileSync(join(workspace, "a.txt"), "hello\n");
  spawnSync("git", ["init", "-q"], { cwd: workspace });
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
    // 快照用完即删
    expect(existsSync(join(dir, "verify-ws-0"))).toBe(false);

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
  test("全流程 → awaiting_acceptance", () => {
    const id = newTask("a.txt 存在");
    const r = run(["team", "run", id, "--dsh", "--workspace", workspace]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("awaiting_acceptance");
    expect(existsSync(join(data, "runs", id, "usage.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(data, "runs", id, "verify.json"), "utf8")).conclusion).toBe("通过");
  }, 30000);
});
