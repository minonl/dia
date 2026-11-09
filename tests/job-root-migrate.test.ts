import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// job 根：沙箱不回退旧根、写入门控、legacy 迁移
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let home: string, data: string, jobRoot: string, legacy: string;
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, HOME: home, DIA_HOME: home, DIA_DATA_DIR: undefined as any, DIA_ROOT: data, DIA_JOB_ROOT: jobRoot, DIA_JOB_NO_LAUNCHD: "1", ...env } as any,
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "dia-jr-"));
  home = join(base, "home"); mkdirSync(home, { recursive: true });
  data = join(base, "data"); mkdirSync(data, { recursive: true });
  jobRoot = join(base, "job"); mkdirSync(join(jobRoot, "tasks"), { recursive: true });
  legacy = join(home, ".local/share/dia-job"); mkdirSync(join(legacy, "tasks"), { recursive: true });
});

function regTask(root: string, name: string, task: any) {
  writeFileSync(join(root, "tasks", "registry.json"), JSON.stringify({ tasks: { [name]: task } }));
}

describe("job 根解析与门控", () => {
  test("沙箱数据根（临时目录）不回退 legacy 根", () => {
    regTask(legacy, "x", { type: "periodic", cmd: "echo x" });
    const env = { ...process.env, HOME: home, DIA_ROOT: join(tmpdir(), "dia-jr-tmp-" + process.pid), DIA_JOB_ROOT: "" };
    const r = spawnSync("bun", ["-e", 'import { jobRootSource, jobRootResolved } from "./src/job.ts"; console.log(jobRootSource(), jobRootResolved())'], {
      encoding: "utf8", cwd: join(import.meta.dir, ".."), env,
    });
    expect(r.stdout.split(" ")[0]).toBe("next");
    expect(r.stdout).not.toContain(".local/share/dia-job");
  });

  test("显式写到 legacy 根 → E_JOB_ROOT_LEGACY", () => {
    const r = spawnSync("bun", ["-e", 'import { assertWritableJobRoot } from "./src/job.ts"; try { assertWritableJobRoot(process.env.DIA_JOB_ROOT); console.log("ALLOW") } catch (e:any) { console.log(e.message) }'], {
      encoding: "utf8", cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: home, DIA_ROOT: data, DIA_JOB_ROOT: legacy },
    });
    expect(r.stdout).toContain("E_JOB_ROOT_LEGACY");
  });
});

describe("dia job migrate", () => {
  test("dry-run 只列计划，不动 registry", () => {
    regTask(legacy, "demo", { type: "periodic", cmd: "echo hi", interval: "300", desc: "demo" });
    const r = run(["job", "migrate", "--from", legacy, "--to", jobRoot, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("将迁移");
    expect(existsSync(join(jobRoot, "tasks", "registry.json"))).toBe(false);
  });

  test("真实迁移：装到新根、清掉旧根，跳过临时命令", () => {
    regTask(legacy, "demo", { type: "periodic", cmd: "echo hi", interval: "300", desc: "demo" });
    writeFileSync(join(legacy, "tasks", "registry.json"), JSON.stringify({
      tasks: {
        demo: { type: "periodic", cmd: "echo hi", interval: "300", desc: "demo" },
        poisoned: { type: "periodic", cmd: "DIA_ROOT='/var/folders/x' dia collab observe", interval: "300" },
      },
    }));
    const r = run(["job", "migrate", "--from", legacy, "--to", jobRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("跳过");
    const to = JSON.parse(readFileSync(join(jobRoot, "tasks", "registry.json"), "utf8")).tasks;
    expect(Object.keys(to)).toContain("demo");
    expect(Object.keys(to)).not.toContain("poisoned");
    const from = JSON.parse(readFileSync(join(legacy, "tasks", "registry.json"), "utf8")).tasks;
    expect(Object.keys(from)).not.toContain("demo");
  });
});
