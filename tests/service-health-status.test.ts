// tests/service-health-status.test.ts — `dia job status` 的 health 列（只读缓存读取方）
// 设计见 docs/service-noun.md §4.5 / §4.6 / §6 / §7 / §10：
//   · 只读最近一条**已决定状态**，不执行 healthcheck，不重算 candidate/streak；
//   · 三态口径 `n/a (adopted)` / `n/a (no healthcheck)` / `unknown (never)` 互不混用；
//   · 新鲜度超 interval×1.5 → `unknown (stale …)`，不显示旧 ok；
//   · 坏行 / 半写行 / 异常 lock 都不能让有效结果「静默丢失」。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "../src/service.ts";

const NOW = 1_800_000_000;

/** 一条合法的 `kind:"health"` 台账行（字段与 §4.5 一致）。 */
function rec(id: string, gen: string, state: "ok" | "degraded" | "fail", ts: number, over: Record<string, unknown> = {}) {
  return {
    ts, kind: "health", service: id, gen, source: "schedule", state, candidate: state, streak: 2,
    raw: state, exit: state === "ok" ? 0 : state === "degraded" ? 20 : 21, timeout: false, detail: "", ...over,
  };
}

let root: string;
let svcHome: string;
let jr: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "svc-health-status-"));
  svcHome = join(root, "services");
  jr = join(root, "job");
  mkdirSync(svcHome, { recursive: true });
  mkdirSync(join(jr, "tasks"), { recursive: true });
  // 隔离宿主：不许读真机 ~/.dia/services（显式参数为主，env 兜底也要干净）
  process.env.DIA_SERVICE_HOME = svcHome;
  process.env.DIA_JOB_ROOT = jr;
});
afterEach(() => {
  delete process.env.DIA_SERVICE_HOME;
  delete process.env.DIA_JOB_ROOT;
  delete process.env.DIA_SERVICE_HEALTH_FILE;
  rmSync(root, { recursive: true, force: true });
});

/** 装一个服务：<servicesRoot>/<id>/dia.json（可选 healthcheck）+ 台账。 */
function install(
  id: string,
  opts: { gen?: string; lock?: boolean; healthcheck?: Record<string, unknown> | null; lines?: any[]; at?: string } = {},
) {
  const { gen = "g-abc123", lock = true, healthcheck = { cmd: "bin/hc" }, lines = [], at = svcHome } = opts;
  const dir = join(at, id);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "hc"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "bin", "hc"), 0o755);
  writeFileSync(join(dir, "dia.json"), JSON.stringify({
    schema: 1, kind: "service", id, version: "0.1.0",
    entry: { cmd: "bin/worker" },
    lifecycle: { type: "periodic", interval: 300 },
    ...(healthcheck ? { healthcheck } : {}),
  }));
  if (lock) {
    writeFileSync(join(dir, "service.lock.json"), JSON.stringify({
      schema: 1, kind: "service", id, version: "0.1.0", dir, gen, added_at: "2026-01-01T00:00:00.000Z",
      entry: { declared: "bin/worker", kind: "repo", path: join(dir, "bin", "worker"), link: null },
      jobs: { service: `svc-${id}`, health: healthcheck ? `svc-${id}-health` : null },
      files: {},
    }));
  }
  const ledger = join(jr, "tasks", `svc-${id}-health.state.jsonl`);
  writeFileSync(ledger, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (lines.length ? "\n" : ""));
  return { dir, ledger };
}

describe("readServiceHealth：正常读取（只读缓存）", () => {
  test("本代际最近一条已决定状态 → ok (5m ago)", () => {
    install("w1", { lines: [rec("w1", "g-abc123", "ok", NOW - 300)] });
    const v = s.readServiceHealth("w1", { jobRoot: jr, now: NOW });
    expect(v).toMatchObject({ health: "ok", note: "", stale: false, checked_at: NOW - 300, age: 300 });
    expect(v.label).toBe("ok (5m ago)");
  });

  test("取**最近**一条而不是第一条；degraded / fail 原样展示", () => {
    install("w2", { lines: [
      rec("w2", "g-abc123", "fail", NOW - 900),
      rec("w2", "g-abc123", "ok", NOW - 600),
      rec("w2", "g-abc123", "degraded", NOW - 120),
    ] });
    expect(s.readServiceHealth("w2", { jobRoot: jr, now: NOW })).toMatchObject({ health: "degraded", checked_at: NOW - 120 });
  });

  test("零执行：healthcheck.cmd 是会让外部判据「炸掉」的命令，读取方照样只读台账", () => {
    const marker = join(root, "executed");
    install("w3", { healthcheck: { cmd: `touch ${marker}; exit 0` }, lines: [rec("w3", "g-abc123", "ok", NOW - 10)] });
    expect(s.readServiceHealth("w3", { jobRoot: jr, now: NOW }).health).toBe("ok");
    expect(existsSync(marker)).toBe(false);
  });

  test("单一写入方：读取方不重算——矛盾的 candidate/streak 不影响已决定状态", () => {
    install("w4", { lines: [rec("w4", "g-abc123", "ok", NOW - 30, { candidate: "fail", streak: 99 })] });
    expect(s.readServiceHealth("w4", { jobRoot: jr, now: NOW }).health).toBe("ok");
  });

  test("manifest 优先用 lock 记录的安装目录（与 <servicesRoot>/<id> 不同也能读）", () => {
    const elsewhere = join(root, "elsewhere");
    const { dir } = install("w5", { lines: [rec("w5", "g-abc123", "fail", NOW - 5)] });
    // lock 指向另一个目录（如源仓），且那里也有 dia.json
    install("w5", { at: elsewhere, lock: false, lines: [rec("w5", "g-abc123", "fail", NOW - 5)] });
    const lock = JSON.parse(readFileSync(join(dir, "service.lock.json"), "utf8"));
    writeFileSync(join(dir, "service.lock.json"), JSON.stringify({ ...lock, dir: join(elsewhere, "w5") }));
    rmSync(join(dir, "dia.json"));
    expect(s.readServiceHealth("w5", { jobRoot: jr, now: NOW }).health).toBe("fail");
  });
});

describe("readServiceHealth：三态口径（§7）", () => {
  test("无 dia.json → n/a (adopted)，台账有行也不冒充", () => {
    install("a1", { lock: false, healthcheck: null, lines: [rec("a1", "g-abc123", "ok", NOW - 10)] });
    rmSync(join(svcHome, "a1", "dia.json"));
    expect(s.readServiceHealth("a1", { jobRoot: jr, now: NOW })).toMatchObject({ health: "n/a", note: "adopted", label: "n/a (adopted)" });
  });

  test("未安装 / 目录不存在 → n/a (adopted)", () => {
    expect(s.readServiceHealth("ghost", { jobRoot: jr, now: NOW })).toMatchObject({ health: "n/a", note: "adopted" });
  });

  test("有 dia.json 但没声明 healthcheck → n/a (no healthcheck)", () => {
    install("n1", { healthcheck: null, lines: [rec("n1", "g-abc123", "ok", NOW - 10)] });
    expect(s.readServiceHealth("n1", { jobRoot: jr, now: NOW })).toMatchObject({ health: "n/a", note: "no healthcheck", label: "n/a (no healthcheck)" });
  });

  test("从未跑过（台账不存在 / 空）→ unknown (never)", () => {
    install("n2");
    expect(s.readServiceHealth("n2", { jobRoot: jr, now: NOW })).toMatchObject({ health: "unknown", note: "never", label: "unknown (never)" });
  });

  test("三种 n/a/never 的 label 互不相同", () => {
    install("a2");
    rmSync(join(svcHome, "a2", "dia.json"));
    install("n3", { healthcheck: null });
    install("n4");
    const labels = ["a2", "n3", "n4"].map((id) => s.readServiceHealth(id, { jobRoot: jr, now: NOW }).label);
    expect(labels).toEqual(["n/a (adopted)", "n/a (no healthcheck)", "unknown (never)"]);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("readServiceHealth：新鲜度（§4.6）", () => {
  test("超 interval×1.5 → unknown (stale …)，不再显示旧 ok", () => {
    // 默认 interval 1800s → 窗口 2700s
    install("f1", { lines: [rec("f1", "g-abc123", "ok", NOW - 2820)] });
    const v = s.readServiceHealth("f1", { jobRoot: jr, now: NOW });
    expect(v).toMatchObject({ health: "unknown", note: "stale", stale: true, checked_at: NOW - 2820 });
    expect(v.label).not.toContain("ok");
    expect(v.label).toStartWith("unknown (stale ");
  });

  test("边界：恰好 interval×1.5 仍算新鲜；多 1 秒即 stale", () => {
    install("f2", { lines: [rec("f2", "g-abc123", "ok", NOW - 2700)] });
    install("f3", { lines: [rec("f3", "g-abc123", "ok", NOW - 2701)] });
    expect(s.readServiceHealth("f2", { jobRoot: jr, now: NOW }).health).toBe("ok");
    expect(s.readServiceHealth("f3", { jobRoot: jr, now: NOW })).toMatchObject({ health: "unknown", stale: true });
  });

  test("清单自定义 interval 决定窗口（600s → 900s）", () => {
    install("f4", { healthcheck: { cmd: "bin/hc", interval: 600 }, lines: [rec("f4", "g-abc123", "fail", NOW - 1000)] });
    expect(s.readServiceHealth("f4", { jobRoot: jr, now: NOW })).toMatchObject({ health: "unknown", stale: true });
  });

  test("新鲜员额内 checked_at / age 与台账 ts 一致", () => {
    install("f5", { lines: [rec("f5", "g-abc123", "degraded", NOW - 61, { timeout: true, exit: 124 })] });
    expect(s.readServiceHealth("f5", { jobRoot: jr, now: NOW })).toMatchObject({ health: "degraded", age: 61, checked_at: NOW - 61 });
  });
});

describe("readServiceHealth：坏行 / 半写行 / 旧代际 / 异常 lock", () => {
  test("坏行（非 JSON）跳过，取前一条有效结果", () => {
    install("b1", { lines: [rec("b1", "g-abc123", "ok", NOW - 100), "{not json", ""] });
    expect(s.readServiceHealth("b1", { jobRoot: jr, now: NOW }).health).toBe("ok");
  });

  test("末尾半写行：state 被截断 → 跳过半写行，回退到上一条有效结果", () => {
    install("b3", { lines: [rec("b3", "g-abc123", "ok", NOW - 200), '{"ts":' + (NOW - 5) + ',"kind":"health","sta'] });
    expect(s.readServiceHealth("b3", { jobRoot: jr, now: NOW })).toMatchObject({ health: "ok", checked_at: NOW - 200 });
  });

  test("无 lock 时，末尾「state 完整、后段被截断」的半写行按当前 ts 展示（急停场景救回）", () => {
    const partial = '{"ts":' + (NOW - 5) + ',"kind":"health","service":"b2","gen":"g-abc123","state":"ok","cand';
    install("b2", { lock: false, lines: [rec("b2", "g-abc123", "fail", NOW - 200), partial] });
    expect(s.readServiceHealth("b2", { jobRoot: jr, now: NOW })).toMatchObject({ health: "ok", checked_at: NOW - 5 });
  });

  test("有 lock 时，同一半写行（gen 落在被截断的后段）也不会遮住有效结果", () => {
    const partial = '{"ts":' + (NOW - 5) + ',"kind":"health","service":"b2","gen":"g-abc123","state":"ok","cand';
    install("b2", { lines: [rec("b2", "g-abc123", "fail", NOW - 200), partial] });
    expect(s.readServiceHealth("b2", { jobRoot: jr, now: NOW })).toMatchObject({ health: "fail", checked_at: NOW - 200 });
  });

  test("state 缺失 / 写坏成任意字符串 → 不可用结果，继续向前找（不读成 never）", () => {
    install("b4", { lines: [
      rec("b4", "g-abc123", "ok", NOW - 60),
      { ts: NOW - 30, kind: "health", service: "b4", gen: "g-abc123" },
      { ts: NOW - 20, kind: "health", service: "b4", gen: "g-abc123", state: "bogus" },
    ] });
    expect(s.readServiceHealth("b4", { jobRoot: jr, now: NOW }).health).toBe("ok");
  });

  test("state=unknown 的历史行（如 §4.4 首次巡检即 crash）不遮住上一条有效状态", () => {
    const crash = rec("b5", "g-abc123", "ok", NOW - 30, { state: "unknown", raw: "crash", candidate: "crash", streak: 1, exit: null, detail: "killed by SIGSEGV", last_error: "killed by SIGSEGV" });
    // 有 lock：保留 gen，只跳过 unknown 行
    install("b5", { lines: [rec("b5", "g-abc123", "ok", NOW - 90), crash] });
    expect(s.readServiceHealth("b5", { jobRoot: jr, now: NOW })).toMatchObject({ health: "ok", checked_at: NOW - 90 });
    // 无 lock：真实 crash 行（readHealthLines 视为可解析）同样不能遮住
    install("b5", { lock: false, lines: [rec("b5", "g-abc123", "ok", NOW - 90), crash] });
    expect(s.readServiceHealth("b5", { jobRoot: jr, now: NOW })).toMatchObject({ health: "ok", checked_at: NOW - 90 });
  });

  test("旧代际行不参与本代际（重装后不继承旧 ok），且同服务其它行的 ts 互不干扰", () => {
    // 本代际行存在时只认本代际
    install("b6", { gen: "g-new", lines: [rec("b6", "g-old", "fail", NOW - 10), rec("b6", "g-new", "ok", NOW - 60)] });
    expect(s.readServiceHealth("b6", { jobRoot: jr, now: NOW })).toMatchObject({ health: "ok", checked_at: NOW - 60 });
  });

  test("lock 的 gen 与台账对不上 → 退化到同服务 ts 最新，不静默丢结果", () => {
    install("b7", { gen: "g-locked", lines: [rec("b7", "g-other", "fail", NOW - 15)] });
    expect(s.readServiceHealth("b7", { jobRoot: jr, now: NOW }).health).toBe("fail");
  });

  test("lock 丢失 → 不限 gen，取同服务 ts 最新（别的服务的行不串）", () => {
    install("b8", { lock: false, lines: [
      rec("b8", "g-x", "degraded", NOW - 300),
      rec("other", "g-x", "fail", NOW - 10),
      rec("b8", "g-x", "ok", NOW - 100),
    ] });
    expect(s.readServiceHealth("b8", { jobRoot: jr, now: NOW }).health).toBe("ok");
  });

  test("lock 损坏（不可解析）→ 退化为 manifest 口径", () => {
    const { dir } = install("b9", { lines: [rec("b9", "g-any", "degraded", NOW - 40)] });
    writeFileSync(join(dir, "service.lock.json"), "{oops");
    expect(s.readServiceHealth("b9", { jobRoot: jr, now: NOW }).health).toBe("degraded");
  });

  test("非 health 的 run 行（无 kind）不参与 health 列", () => {
    install("b10", { lines: [{ ts: NOW - 5, exit: 0, verdict: "ok", errors: [] }] });
    expect(s.readServiceHealth("b10", { jobRoot: jr, now: NOW }).note).toBe("never");
  });
});

describe("readServiceHealth：安装根口径", () => {
  test("默认 = DIA_SERVICE_HOME（不是 <jobRoot>/services）+ <jobRoot>/tasks 台账", () => {
    install("h1", { lines: [rec("h1", "g-abc123", "ok", NOW - 20)] });
    // 不传任何参数：env 已指向临时根
    expect(s.readServiceHealth("h1", { now: NOW })).toMatchObject({ health: "ok", checked_at: NOW - 20 });
  });

  test("显式 servicesRoot 覆盖 env；不传 jobRoot 时台账跟随 DIA_JOB_ROOT", () => {
    const other = join(root, "other-services");
    install("h2", { at: other, lines: [rec("h2", "g-abc123", "fail", NOW - 20)] });
    expect(s.readServiceHealth("h2", { servicesRoot: other, now: NOW }).health).toBe("fail");
  });

  test("未设置 DIA_SERVICE_HOME 时回落到 <jobRoot>/services（job 侧默认布局）", () => {
    delete process.env.DIA_SERVICE_HOME;
    install("h3", { at: join(jr, "services"), lines: [rec("h3", "g-abc123", "ok", NOW - 20)] });
    expect(s.readServiceHealth("h3", { jobRoot: jr, now: NOW }).health).toBe("ok");
  });

  test("jobRoot 不存在 / 台账缺失也不抛错", () => {
    install("h4");
    expect(() => s.readServiceHealth("h4", { jobRoot: join(root, "nope"), now: NOW })).not.toThrow();
  });
});

describe("dia job status 追列（decorateStatus，纯函数）", () => {
  test("svc 标签行后追加 health，其它行原样", () => {
    const text = "  例子 periodic  local.dia-job-svc-demo\n      调度=1800\n";
    const out = s.decorateStatus(text, () => ({ label: "ok (5m ago)" }));
    expect(out).toContain("local.dia-job-svc-demo");
    expect(out).toContain("      health=ok (5m ago)");
    expect(out).toContain("      调度=1800");
  });

  test("非 svc 行不追加", () => {
    const out = s.decorateStatus("  yan-update periodic  local.dia-job-update\n", () => ({ label: "ok" }));
    expect(out).not.toContain("health=");
  });

  test("view 抛错不影响输出（读缓存失败不拖垮 status）", () => {
    const text = "  x periodic  local.dia-job-svc-bad\n";
    const out = s.decorateStatus(text, () => { throw new Error("boom"); });
    expect(out).toContain("local.dia-job-svc-bad");
  });
});
