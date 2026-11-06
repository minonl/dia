// tests/service-health-status.perf.test.ts — §6 / §10 性能基准：`dia job status` 的 health 列
//
// 设计要求：**只读缓存、零执行**；N=50 个服务时 ≤200ms，且不随服务数线性增长（不得每个服务起进程/发网络请求）。
// 这里直接压 `decorateStatus` + 50 份真实台账文件（status 里最贵的就是这 50 次读盘），
// 用「最慢一项取 3 次最好值」保证在共享 CI runner 上不抖。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "../src/service.ts";

const NOW = 1_800_000_000;
const N = 50;

let root: string;
let jobRoot: string;
let svcHome: string;

const setupServices = (n: number) => {
  for (let i = 0; i < n; i++) {
    const id = `demo-${i}`;
    const dir = join(svcHome, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify({
      schema: 1, kind: "service", id, version: "0.1.0",
      entry: { cmd: "bin/run" },
      lifecycle: { type: "periodic", interval: 1800 },
      healthcheck: { cmd: "bin/healthcheck", interval: 1800, timeout: 30 },
    }));
    const tasks = join(jobRoot, "tasks");
    mkdirSync(tasks, { recursive: true });
    const ledger = join(tasks, `svc-${id}-health.state.jsonl`);
    const line = (ts: number) => JSON.stringify({
      ts, kind: "health", service: id, gen: "g1", source: "schedule",
      state: "ok", candidate: "ok", streak: 2, raw: "ok", exit: 0, timeout: false, detail: "",
    });
    writeFileSync(ledger, `${line(NOW - 60)}\n${line(NOW - 30)}\n`);
  }
};

/** 造一份 `dia job status` 的文本（每个服务一行，带 `local.dia-job-svc-<id>` 标签） */
const statusText = (n: number) => Array.from({ length: n }, (_, i) =>
  `  demo-${i} periodic  local.dia-job-svc-demo-${i}\n      调度=1800\n      状态=not running\n`).join("");

const timeOnce = (n: number) => {
  const text = statusText(n);
  const t0 = performance.now();
  const out = s.decorateStatus(text, (id) => s.readServiceHealth(id, { servicesRoot: svcHome, now: NOW }));
  const ms = performance.now() - t0;
  return { ms, out };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "svc-health-perf-"));
  jobRoot = join(root, "job");
  svcHome = join(root, "services");
  process.env.DIA_JOB_ROOT = jobRoot;
  process.env.DIA_SERVICE_HOME = svcHome;
});

afterEach(() => {
  delete process.env.DIA_JOB_ROOT;
  delete process.env.DIA_SERVICE_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("§6 性能：health 列只读缓存", () => {
  test(`N=${N} 时 decorateStatus ≤ 200ms，且不随 N 线性增长（零执行）`, () => {
    setupServices(N);
    // 预热一次（首次读模块/缓存），再取 3 次最好值
    timeOnce(N);
    const runs = [0, 1, 2].map(() => timeOnce(N).ms);
    const best = Math.min(...runs);

    // 单服务的基准
    const one = Math.min(...[0, 1, 2].map(() => timeOnce(1).ms));

    // 断言 1：绝对值（设计要求 ≤200ms）
    expect(best).toBeLessThan(200);
    // 断言 2：不是「每个服务起进程」那种线性爆炸（50 份 ≈ 同量级，而不是 50 倍单次）
    expect(best).toBeLessThan(Math.max(one * 10, 20));

    console.log(`[perf] N=${N}: ${best.toFixed(1)}ms（单服务 ${one.toFixed(1)}ms）`);
  });

  test("50 条 health 行全部渲染（没有因为性能优化而丢行）", () => {
    setupServices(N);
    const { out } = timeOnce(N);
    const hits = (out.match(/health=ok/g) || []).length;
    expect(hits).toBe(N);
  });
});
