import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// D：doctor 只读聚合 job 级健康（只 warn，不改 verdict）
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["HOME", "DIA_ROOT", "DIA_JOB_ROOT", "DIA_JOB_NO_LAUNCHD"]) SAVED[k] = process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
async function runWith(home: string, root: string) {
  Object.assign(process.env, { HOME: home, DIA_ROOT: "", DIA_JOB_ROOT: root, DIA_JOB_NO_LAUNCHD: "1" });
  const mod = await import("../src/doctor.ts");
  return mod.jobHealthCheck();
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "dia-jh-"));
  const home = join(base, "home");
  const root = join(base, "job");
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, home, root, tasks: join(root, "tasks") };
}

const reg = (tasks: string, file: string, body: any) => writeFileSync(file, JSON.stringify(body));

describe("doctor job.health（只读、只 warn）", () => {
  test("全部 ok → ok", async () => {
    const { home, root, tasks } = setup();
    reg("", join(tasks, "registry.json"), { tasks: { a: { type: "periodic" } } });
    writeFileSync(join(tasks, "a.state.jsonl"), '{"ts":1,"exit":0,"verdict":"ok"}\n');
    const c = await runWith(home, root);
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("1 个任务");
  });

  test("有 failed → warn 且点名（不判 fail）", async () => {
    const { home, root, tasks } = setup();
    reg("", join(tasks, "registry.json"), { tasks: { a: { type: "periodic" }, b: { type: "periodic" } } });
    writeFileSync(join(tasks, "a.state.jsonl"), '{"ts":1,"exit":0,"verdict":"ok"}\n');
    writeFileSync(join(tasks, "b.state.jsonl"), '{"ts":2,"exit":1,"verdict":"failed"}\n');
    const c = await runWith(home, root);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("b");
    expect(c.detail).toContain("failed");
    expect(c.detail).toContain("1/2");
  });

  test("无 state → warn（可能从未跑过）", async () => {
    const { home, root, tasks } = setup();
    reg("", join(tasks, "registry.json"), { tasks: { a: { type: "periodic" } } });
    const c = await runWith(home, root);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("无 state");
  });

  test("service 的 stopped 也算非 ok（提示但不判 fail）", async () => {
    const { home, root, tasks } = setup();
    reg("", join(tasks, "registry.json"), { tasks: { s: { type: "service" } } });
    writeFileSync(join(tasks, "s.state.jsonl"), '{"ts":3,"exit":143,"verdict":"stopped","type":"service"}\n');
    const c = await runWith(home, root);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("stopped");
  });
});
