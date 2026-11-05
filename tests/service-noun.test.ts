// tests/service-noun.test.ts — 服务（service）名词：清单 / 入口 / health 码域 / 去抖 / 新鲜度 / 读写方分离
// 设计见 docs/service-noun.md §10（验收标准）。全部用临时目录 + 注入 runner，不碰真机的 launchd/cron。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as s from "../src/service.ts";

const base = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "service",
  id: "example-worker",
  version: "0.1.0",
  entry: { cmd: "bin/worker" },
  lifecycle: { type: "periodic", interval: 300 },
  ...over,
});

const judge = (exit: number | null, signal?: string | number) => s.judgeHealth(exit, { signal });

describe("清单（dia.json kind=service）", () => {
  test("最小清单通过；顶层规则与 persona/kit 共用", () => {
    expect(s.validateServiceManifest(base()).id).toBe("example-worker");
  });

  test("schema / kind / id / version 不合规", () => {
    expect(() => s.validateServiceManifest(base({ schema: 2 }))).toThrow(/E_MANIFEST/);
    expect(() => s.validateServiceManifest(base({ kind: "kit" }))).toThrow(/E_MANIFEST/);
    expect(() => s.validateServiceManifest(base({ id: "Bad_ID" }))).toThrow(/E_MANIFEST/);
    expect(() => s.validateServiceManifest(base({ version: "1.0" }))).toThrow(/E_MANIFEST/);
    expect(() => s.validateServiceManifest([])).toThrow(/E_MANIFEST/);
  });

  test("entry.cmd 必需", () => {
    expect(() => s.validateServiceManifest(base({ entry: { cmd: "" } }))).toThrow(/entry/);
    expect(() => s.validateServiceManifest(base({ entry: "bin/x" }))).toThrow(/entry/);
  });

  test("lifecycle：type 枚举；periodic 需要 interval", () => {
    expect(() => s.validateServiceManifest(base({ lifecycle: { type: "daemon" } }))).toThrow(/lifecycle.type/);
    expect(() => s.validateServiceManifest(base({ lifecycle: { type: "periodic" } }))).toThrow(/interval required/);
    expect(s.validateServiceManifest(base({ lifecycle: { type: "bounded" } })).lifecycle.type).toBe("bounded");
  });

  test("lifecycle.target 必须是非空字符串", () => {
    expect(() => s.validateServiceManifest(base({ lifecycle: { type: "bounded", target: " " } }))).toThrow(/target/);
  });

  test("healthcheck：码表不得重叠；interval 走 cron 约束；timeout/debounce 正整数", () => {
    const hc = (o: Record<string, unknown>) => base({ healthcheck: { cmd: "bin/hc", ...o } });
    expect(() => s.validateServiceManifest(hc({ degraded_exit: [0] }))).toThrow(/overlap/);
    expect(() => s.validateServiceManifest(hc({ interval: 30 }))).toThrow(/interval/);
    expect(() => s.validateServiceManifest(hc({ interval: 420 }))).toThrow(/E_MANIFEST/);
    expect(() => s.validateServiceManifest(hc({ timeout: 0 }))).toThrow(/timeout/);
    expect(() => s.validateServiceManifest(hc({ debounce: -1 }))).toThrow(/debounce/);
    expect(() => s.validateServiceManifest(hc({}))).not.toThrow();
  });

  test("contract 只声明：2=retry 与 health 码「长得像」也不报错", () => {
    const m = base({ contract: { stdin: "json", exit: "0=ok/2=retry", idempotent_by: "event_id" } });
    expect(() => s.validateServiceManifest(m)).not.toThrow();
    expect(() => s.validateServiceManifest(base({ contract: { stdin: "xml" } }))).toThrow(/contract.stdin/);
  });

  test("readServiceManifest：无 dia.json → E_NO_MANIFEST（adopted）", () => {
    const d = mkdtempSync(join(tmpdir(), "svc-manifest-"));
    try {
      expect(() => s.readServiceManifest(d)).toThrow(/E_NO_MANIFEST/);
      writeFileSync(join(d, "dia.json"), "{not json");
      expect(() => s.readServiceManifest(d)).toThrow(/invalid json/);
      writeFileSync(join(d, "dia.json"), JSON.stringify(base()));
      expect(s.readServiceManifest(d).id).toBe("example-worker");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("cron 可表达性（E_BACKEND）", () => {
  test("≥60s 且整分、*/N 整除 1440、≤23h", () => {
    expect(s.checkCronInterval(300)).toBeNull();
    expect(s.checkCronInterval(3600)).toBeNull();
    expect(s.checkCronInterval(30)).toMatch(/60s/);
    expect(s.checkCronInterval(90)).toMatch(/整分/);
    expect(s.checkCronInterval(420)).toMatch(/1440/);
    expect(s.checkCronInterval(24 * 3600)).toMatch(/23h/);
    // 整秒但非整分 / 非数字：显式说明，而不是算出小数分钟静默 null
    expect(s.checkCronInterval(90.5)).toMatch(/不是整数秒/);
    expect(s.checkCronInterval(90)).toMatch(/整分/);
    expect(s.checkCronInterval(NaN)).toMatch(/必须是数字/);
  });

  test("cronSpecFor 生成 */N 与 0 */H", () => {
    expect(s.cronSpecFor(300)).toBe("*/5 * * * *");
    expect(s.cronSpecFor(7200)).toBe("0 */2 * * *");
    expect(s.cronSpecFor(420)).toBeNull();
  });

  test("默认 healthcheck 周期 1800s；显式不合规 → E_BACKEND", () => {
    const svc = s.validateServiceManifest(base({ healthcheck: { cmd: "bin/hc" } }));
    expect(s.healthJobInterval(svc)).toBe(1800);
    // 清单校验拦截在前（E_MANIFEST）；healthJobInterval 自身面对同一约束报 E_BACKEND（安装期后端表达不了）
    expect(() => s.validateServiceManifest(base({ healthcheck: { cmd: "bin/hc", interval: 420 } }))).toThrow(/interval/);
    const bad = base({ healthcheck: { cmd: "bin/hc", interval: 420 } }) as any;
    expect(() => s.healthJobInterval(bad)).toThrow(/E_BACKEND/);
  });

  test("healthcheck 码表不得占用 124（wrapper timeout 预留）", () => {
    expect(() => s.assertHealthcheckSupported({ cmd: "x", fail_exit: [124] })).toThrow(/124/);
    expect(() => s.assertHealthcheckSupported({ cmd: "x", interval: 30 })).toThrow(/≥60s/);
  });
});

describe("退出码映射（§4.1）", () => {
  test("0 ok / 20 degraded / 21 fail", () => {
    expect(judge(0)).toMatchObject({ state: "ok", inDomain: true, timeout: false });
    expect(judge(20)).toMatchObject({ state: "degraded", inDomain: true });
    expect(judge(21)).toMatchObject({ state: "fail", inDomain: true });
  });

  test("124 → degraded + timeout（参与去抖）", () => {
    expect(judge(124)).toMatchObject({ state: "degraded", timeout: true, inDomain: true, detail: "timeout" });
  });

  test("137 / 143 → crash（不参与去抖）", () => {
    expect(judge(null, 9)).toMatchObject({ state: "crash", inDomain: false });
    expect(judge(null, "SIGTERM")).toMatchObject({ state: "crash", signal: "SIGTERM" });
    expect(judge(137)).toMatchObject({ state: "crash", inDomain: false });
  });

  test("码域隔离：2（contract.exit 的 retry）与 4 都是 crash，不被读成 degraded", () => {
    expect(judge(2)).toMatchObject({ state: "crash", inDomain: false });
    expect(judge(4)).toMatchObject({ state: "crash", inDomain: false });
  });

  test("可覆盖 ok_exit / degraded_exit / fail_exit", () => {
    const codes = s.healthCodes({ cmd: "x", ok_exit: [10], degraded_exit: [40], fail_exit: [50] });
    expect(s.judgeHealth(10, { codes }).state).toBe("ok");
    expect(s.judgeHealth(40, { codes }).state).toBe("degraded");
    expect(s.judgeHealth(0, { codes }).state).toBe("crash");
  });

  test("health 子命令退出码 0 / 30 / 1 / 31", () => {
    expect(s.healthExitCode(judge(0))).toBe(0);
    expect(s.healthExitCode(judge(20))).toBe(30);
    expect(s.healthExitCode(judge(124))).toBe(30);
    expect(s.healthExitCode(judge(21))).toBe(1);
    expect(s.healthExitCode(judge(2))).toBe(31);
    expect(s.HEALTH_EXIT.usage).toBe(2);
  });

  test("judgeSpawnResult：spawn 错误 / killed → crash、超时 → 124 语义", () => {
    expect(s.judgeSpawnResult({ status: 0 }).state).toBe("ok");
    expect(s.judgeSpawnResult({ status: null, error: { code: "ENOENT", message: "spawn bash ENOENT" } }).state).toBe("crash");
    expect(s.judgeSpawnResult({ status: null, signal: "SIGKILL" })).toMatchObject({ state: "crash", signal: "SIGKILL" });
  });
});

describe("去抖状态机（§4.3 / §4.4）", () => {
  const rec = (exit: number) => s.transition(null, { service: "x", gen: "g1", source: "schedule", ts: 1, judgement: judge(exit) });
  const step = (prev: s.HealthRecord | null, exit: number, ts = 2, gen = "g1") =>
    s.transition(prev, { service: "x", gen, source: "schedule", ts, judgement: judge(exit) });

  test("首次结果直接生效（unknown → * 不去抖）", () => {
    expect(rec(20).state).toBe("degraded");
  });

  test("[ok, degraded, degraded] 才切 degraded", () => {
    let r = rec(0);
    expect(r.state).toBe("ok");
    r = step(r, 20);
    expect(r.state).toBe("ok");
    expect(r).toMatchObject({ candidate: "degraded", streak: 1 });
    r = step(r, 20);
    expect(r.state).toBe("degraded");
  });

  test("回到已决定状态 → 计数清零", () => {
    let r = step(rec(0), 20);
    r = step(r, 0);
    expect(r).toMatchObject({ state: "ok", candidate: "ok", streak: 0 });
  });

  test("debounce: 1 = 立即切换", () => {
    const one = (prev: s.HealthRecord | null, exit: number) =>
      s.transition(prev, { service: "x", gen: "g1", source: "schedule", ts: 2, judgement: judge(exit), debounce: 1 });
    expect(one(rec(0), 21).state).toBe("fail");
  });

  test("fail → ok 也消抖", () => {
    let r = rec(21);
    expect(r.state).toBe("fail");
    r = step(r, 0);
    expect(r.state).toBe("fail");
    r = step(r, 0);
    expect(r.state).toBe("ok");
  });

  test("124 算一次 degraded，与 20 同权", () => {
    let r = step(rec(0), 124);
    expect(r).toMatchObject({ state: "ok", candidate: "degraded", timeout: true });
    r = step(r, 20);
    expect(r.state).toBe("degraded");
  });

  test("单次 crash 保持上次状态 + last_error；连续 debounce 次 → degraded（判据不可用）", () => {
    let r = rec(0);
    r = step(r, 137);
    expect(r.state).toBe("ok");
    expect(r.last_error).toBeTruthy();
    r = step(r, 2);
    expect(r.state).toBe("degraded");
    expect(r.detail).toMatch(/判据不可用/);
    // 恢复后 last_error 清除
    r = step(r, 0);
    expect(r.last_error).toBeUndefined();
  });

  test("无上一次 + crash：unknown（不产生 ok/fail）", () => {
    const r = s.transition(null, { service: "x", gen: "g1", source: "manual", ts: 1, judgement: judge(137) });
    expect(r.state).toBe("unknown");
  });

  test("旧代际（gen 不同）的行不参与计数", () => {
    const lines: unknown[] = [];
    let r = s.transition(null, { service: "x", gen: "g1", source: "schedule", ts: 1, judgement: judge(0) });
    lines.push(r);
    r = s.transition(s.findLastHealth(lines, "x", "g2"), { service: "x", gen: "g2", source: "schedule", ts: 2, judgement: judge(20) });
    lines.push(r);
    // 新代际的首条 degraded 仍是「首次结果」，直接生效——不接受旧 ok 的去抖
    expect(r).toMatchObject({ state: "degraded", streak: 1 });
    expect(s.findLastHealth(lines, "x", "g1")?.state).toBe("ok");
    expect(s.findLastHealth(lines, "x", "g3")).toBeNull();
    // 坏行 / 无 state 行不会被读成 ok
    expect(s.findLastHealth([null, null, { kind: "health" }, { ts: 1, exit: 0, verdict: "ok" }], "x", "g1")).toBeNull();
  });

  test("结构化 checks 原样透传，不据其自行升降级", () => {
    const r = s.transition(null, {
      service: "x", gen: "g1", source: "manual", ts: 1, judgement: judge(0),
      checks: [{ name: "queue", level: "degraded", detail: "backlog" }],
    });
    expect(r.state).toBe("ok");
    expect(r.checks).toEqual([{ name: "queue", level: "degraded", detail: "backlog" }]);
  });
});

describe("新鲜度（§4.6）", () => {
  const hc = { cmd: "x", interval: 600 };
  const record = (ts: number, state: s.HealthState = "ok"): s.HealthRecord => ({
    ts, kind: "health", service: "x", gen: "g1", source: "schedule", state, candidate: state, streak: 0, raw: state,
    exit: 0, timeout: false, detail: "",
  });

  test("interval × 1.5 窗口内显示状态 + 年龄", () => {
    expect(s.staleAfter(hc)).toBe(900);
    const v = s.healthView({ record: record(1000), hasHealthcheck: true, hc, now: 1300 });
    expect(v).toMatchObject({ health: "ok", stale: false, note: "", checked_at: 1000, age: 300 });
    expect(v.label).toBe("ok (5m ago)");
  });

  test("超窗口 → unknown (stale …)，不再显示旧 ok", () => {
    const v = s.healthView({ record: record(1000), hasHealthcheck: true, hc, now: 1000 + 2820 });
    expect(v).toMatchObject({ health: "unknown", stale: true, note: "stale", checked_at: 1000 });
    expect(v.label).toBe("unknown (stale 47m)");
  });

  test("三态口径：n/a (adopted) / n/a (no healthcheck) / unknown (never) 互不混用", () => {
    expect(s.healthView({ hasHealthcheck: true, adopted: true, now: 0 }).label).toBe("n/a (adopted)");
    expect(s.healthView({ hasHealthcheck: false, now: 0 }).label).toBe("n/a (no healthcheck)");
    expect(s.healthView({ hasHealthcheck: true, now: 0 }).label).toBe("unknown (never)");
  });

  test("默认 interval 1800s → 窗口 2700s", () => {
    expect(s.staleAfter()).toBe(2700);
    expect(s.formatAge(45)).toBe("45s");
    expect(s.formatAge(3600 * 5)).toBe("5h");
  });
});

describe("入口规则（E_UNSTABLE_ENTRY）", () => {
  let entryDir: string;
  let repo: string;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "svc-entry-"));
    entryDir = join(root, "bin");
    repo = join(root, "repo");
    mkdirSync(entryDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    process.env.DIA_JOB_ENTRY_DIR = entryDir;
  });
  afterEach(() => { delete process.env.DIA_JOB_ENTRY_DIR; rmSync(join(entryDir, ".."), { recursive: true, force: true }); });

  test("仓内相对路径 → repo", () => {
    expect(s.resolveEntry("bin/worker", repo)).toMatchObject({ kind: "repo", path: join(repo, "bin", "worker") });
  });

  test("ref-entry（DIA_JOB_ENTRY_DIR 下）→ ref", () => {
    expect(s.resolveEntry(join(entryDir, "worker"), repo)).toMatchObject({ kind: "ref" });
  });

  test("checkout 绝对路径 / `..` 穿越 / 越出仓根 → E_UNSTABLE_ENTRY", () => {
    expect(() => s.resolveEntry("/opt/checkout/bin/worker", repo)).toThrow(/E_UNSTABLE_ENTRY/);
    expect(() => s.resolveEntry("../other/bin/worker", repo)).toThrow(/E_UNSTABLE_ENTRY/);
    expect(() => s.resolveEntry("bin/../../x", repo)).toThrow(/E_UNSTABLE_ENTRY/);
  });

  test("worktree 路径即使落在 entry dir 里也拒收", () => {
    const wt = join(entryDir, "feature-worktree", "worker");
    expect(() => s.resolveEntry(wt, repo)).toThrow(/worktree/);
  });
});

describe("verify（漂移检测）", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "svc-verify-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("干净安装结构 → ok", () => {
    const dir = join(root, "repo");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "worker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", "worker"), 0o755);
    writeFileSync(join(dir, "bin", "hc"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", "hc"), 0o755);
    writeFileSync(join(dir, "dia.json"), JSON.stringify(base({ healthcheck: { cmd: "bin/hc" } })));
    const files = s.collectManagedFiles(dir, { cmd: "bin/hc --json" });
    expect(Object.keys(files).sort()).toEqual(["bin/hc", "dia.json"]);

    const r = s.verify(dir, {
      registry: null,
      lock: {
        schema: 1, kind: "service", id: "example-worker", version: "0.1.0", dir, gen: "g1", added_at: "",
        entry: { declared: "bin/worker", kind: "repo", path: join(dir, "bin", "worker"), link: null },
        jobs: { service: "svc-example-worker", health: "svc-example-worker-health" }, files,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.drift).toEqual([]);
  });

  test("entry 缺失 / 不可执行 / 受管文件漂移 / job 缺失", () => {
    const dir = join(root, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bin-worker"), "#!/bin/sh\n");
    writeFileSync(join(dir, "dia.json"), JSON.stringify(base({ entry: { cmd: "bin-worker" }, healthcheck: { cmd: "bin/hc" } })));
    writeFileSync(join(dir, "bin-hc"), "#!/bin/sh\n");
    const lock = {
      schema: 1 as const, kind: "service" as const, id: "example-worker", version: "0.1.0", dir, gen: "g1", added_at: "",
      entry: { declared: "bin-worker", kind: "repo" as const, path: join(dir, "bin-worker"), link: null },
      jobs: { service: "svc-example-worker", health: "svc-example-worker-health" },
      files: { "dia.json": "deadbeef" },
    };
    const regFile = join(root, "registry.json");
    writeFileSync(regFile, JSON.stringify({ tasks: {} }));
    const r = s.verify(dir, { lock, registry: regFile });
    expect(r.ok).toBe(false);
    const codes = r.drift.map((d) => d.code).sort();
    expect(codes).toContain("entry_not_executable");
    expect(codes).toContain("lock_drift");
    expect(codes).toContain("job_missing");
    expect(codes).toContain("health_job_missing");
  });

  test("registry 不存在 = 未装 job 后端，不算漂移", () => {
    expect(s.readRegistryTasks(join(root, "nope.json"))).toBeNull();
  });
});

describe("只读读取方（§4.3 单一写入方）", () => {
  let root: string;
  const jobRoot = () => join(root, "job");
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "svc-list-"));
    process.env.DIA_SERVICE_HOME = join(root, "services");
    process.env.DIA_JOB_ROOT = jobRoot();
  });
  afterEach(() => {
    delete process.env.DIA_SERVICE_HOME;
    delete process.env.DIA_JOB_ROOT;
    delete process.env.DIA_SERVICE_HEALTH_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  const install = (id: string, manifest: Record<string, unknown>, rows: unknown[]) => {
    const dir = join(root, "services", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify(base({ id, ...manifest })));
    writeFileSync(join(dir, "service.lock.json"), JSON.stringify({
      schema: 1, kind: "service", id, version: "0.1.0", dir, gen: "g1", added_at: "",
      entry: { declared: "bin/worker", kind: "repo", path: join(dir, "bin", "worker"), link: null },
      jobs: { service: s.serviceJobName(id), health: manifest.healthcheck ? s.healthJobName(id) : null }, files: {},
    }));
    mkdirSync(join(jobRoot(), "tasks"), { recursive: true });
    writeFileSync(s.healthStatePath(id), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };

  const row = (state: string, ts: number, over: Record<string, unknown> = {}) => ({
    ts, kind: "health", service: "a", gen: "g1", source: "schedule", state, candidate: state, streak: 0, raw: state,
    exit: 0, timeout: false, detail: "", ...over,
  });

  test("list 只读最近一条已决定状态；即使 candidate/streak 刻意矛盾也不重算", () => {
    const now = 10_000;
    install("a", { healthcheck: { cmd: "bin/hc", interval: 600 } }, [
      row("ok", now - 60),
      row("ok", now - 30, { candidate: "fail", streak: 1 }),
    ]);
    const r = s.listServices({ now, hostname: "h" }).find((x) => x.id === "a")!;
    expect(r).toMatchObject({ health: "ok", stale: false, checked_at: now - 30, jobs: { service: "svc-a", health: "svc-a-health" } });
  });

  test("过期 → stale；从未检查 → never；无 healthcheck → n/a (no healthcheck)", () => {
    const now = 10_000;
    install("a", { healthcheck: { cmd: "bin/hc", interval: 600 } }, [row("ok", now - 1000)]);
    install("b", { healthcheck: { cmd: "bin/hc" } }, []);
    install("c", {}, [row("ok", now)]);
    const rows = s.listServices({ now, hostname: "h", registry: null });
    expect(rows.find((x) => x.id === "a")).toMatchObject({ health: "unknown", stale: true, note: "stale" });
    expect(rows.find((x) => x.id === "b")).toMatchObject({ health: "unknown", note: "never", label: "unknown (never)" });
    expect(rows.find((x) => x.id === "c")).toMatchObject({ health: "n/a", note: "no healthcheck" });
  });

  test("adopted（无 dia.json / lock）→ n/a (adopted)，show 也只读可见", () => {
    const d = join(root, "services", "legacy");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "README.md"), "install: …\n");
    const r = s.listServices({ hostname: "h", registry: null }).find((x) => x.id === "legacy")!;
    expect(r).toMatchObject({ adopted: true, health: "n/a", label: "n/a (adopted)", version: null });
    expect(s.showService("legacy", { hostname: "h", registry: null })?.adopted).toBe(true);
    expect(s.showService("missing", { registry: null })).toBeNull();
  });

  test("target 比对：去 .local + 小写", () => {
    install("a", { lifecycle: { type: "bounded", target: "Build-Mac.local" } }, []);
    expect(s.normalizeHost("Build-Mac.LOCAL")).toBe("build-mac");
    expect(s.listServices({ hostname: "build-mac", registry: null })[0]).toMatchObject({ on_this_host: true, target: "Build-Mac.local" });
    expect(s.listServices({ hostname: "other", registry: null })[0]).toMatchObject({ on_this_host: false });
  });

  test("job registry 缺服务任务 → problem 提示", () => {
    install("a", {}, []);
    const reg = join(jobRoot(), "tasks", "registry.json");
    writeFileSync(reg, JSON.stringify({ tasks: {} }));
    expect(s.listServices({ hostname: "h" })?.find((x) => x.id === "a")?.problem).toMatch(/svc-a/);
  });
});

describe("runServiceHealth（实时执行 + 落台账，source=manual）", () => {
  let root: string;
  const hcDir = (name: string) => join(root, "services", name);

  const install = (id: string, healthcheck: Record<string, unknown>, script: string, at = "bin/hc") => {
    const dir = hcDir(id);
    mkdirSync(dirname(join(dir, at)), { recursive: true });
    writeFileSync(join(dir, at), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, at), 0o755);
    writeFileSync(join(dir, "dia.json"), JSON.stringify(base({ id, healthcheck: { cmd: at, ...healthcheck } })));
  };

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "svc-health-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("ok / degraded / fail 三态退出码 0 / 30 / 1，并追加 manual 行", () => {
    install("ok-svc", { debounce: 1 }, "echo '{\"status\":\"ok\",\"checks\":[{\"name\":\"q\",\"level\":\"ok\"}]}'; exit 0");
    install("deg-svc", { debounce: 1 }, "exit 20");
    install("fail-svc", { debounce: 1 }, "exit 21");
    const stateFile = join(root, "state.jsonl");
    for (const [id, code] of [["ok-svc", 0], ["deg-svc", 30], ["fail-svc", 1]] as const) {
      const r = s.runServiceHealth(id, { servicesRoot: join(root, "services"), stateFile, gen: "g1", now: 1 });
      expect(r.exit).toBe(code);
      expect(r.record.source).toBe("manual");
      expect(r.record.gen).toBe("g1");
    }
    const lines = readFileSync(stateFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.state)).toEqual(["ok", "degraded", "fail"]);
    expect(lines[0].checks).toEqual([{ name: "q", level: "ok" }]);
  });

  test("码域隔离端到端：healthcheck 退出 2 → 判据不可用（31），不是 degraded", () => {
    install("retry-svc", { debounce: 1 }, "exit 2");
    const r = s.runServiceHealth("retry-svc", { servicesRoot: join(root, "services"), stateFile: join(root, "s.jsonl"), gen: "g2" });
    expect(r.exit).toBe(31);
    expect(r.json.verdict).toBe("crash");
  });

  test("cwd = 服务安装目录（dia.json 所在仓根），不是 bin/", () => {
    install("pwd-svc", { debounce: 1 }, "pwd > cwd.txt", "bin/sub/hc");
    const r = s.runServiceHealth("pwd-svc", { servicesRoot: join(root, "services"), stateFile: join(root, "s.jsonl"), gen: "g3" });
    expect(r.exit).toBe(0);
    // stdout 已是 `pwd`；这里读子进程写下的 cwd（符号链接解析后比较，macOS 的 /var → /private/var）
    expect(realpathSync(readFileSync(join(hcDir("pwd-svc"), "cwd.txt"), "utf8").trim())).toBe(realpathSync(hcDir("pwd-svc")));
  });

  test("stdout JSON 不可解析 → crash（不冒充 ok/fail）", () => {
    // 注意 `{` 本身是合法 JSON（GPL 允许「一个值」）；用 GPL 也不合法的输出
    install("bad-json", { debounce: 1 }, 'printf \'%s\\n\' \'{"status": "ok",,}\'');
    const r = s.runServiceHealth("bad-json", { servicesRoot: join(root, "services"), stateFile: join(root, "s.jsonl"), gen: "g4" });
    expect(r.exit).toBe(31);
    expect(r.judgement.detail).toContain("unparseable");
  });

  test("超时 → 124 语义（degraded + timeout），不杀服务本身", () => {
    install("slow-svc", { debounce: 1, timeout: 1 }, "sleep 5; exit 0");
    const r = s.runServiceHealth("slow-svc", { servicesRoot: join(root, "services"), stateFile: join(root, "s.jsonl"), gen: "g5" });
    expect(r.exit).toBe(30);
    expect(r.judgement.timeout).toBe(true);
  });

  test("--from-wrapper 不再执行，只推进状态机（source=schedule）", () => {
    const stateFile = join(root, "w.jsonl");
    const opts = { servicesRoot: join(root, "services"), stateFile, gen: "g1", now: 5 } as const;
    install("boot-svc", { cmd: "false" }, "exit 0");
    // lock 不存在 → generationOf 兜底；这里显式传 gen
    const first = s.runServiceHealth("boot-svc", { ...opts, wrapperExit: 0 });
    expect(first).toMatchObject({ exit: 0, record: { state: "ok", source: "schedule" } });
    const second = s.runServiceHealth("boot-svc", { ...opts, wrapperExit: 20 });
    expect(second).toMatchObject({ exit: 30, record: { state: "ok", candidate: "degraded", streak: 1 } });
  });

  test("未知 id / 未声明 healthcheck → E_USAGE", () => {
    expect(() => s.runServiceHealth("nope", { servicesRoot: join(root, "services") })).toThrow(/E_NOT_INSTALLED/);
    const dir = hcDir("plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify(base({ id: "plain" })));
    expect(() => s.runServiceHealth("plain", { servicesRoot: join(root, "services") })).toThrow(/E_NO_HEALTHCHECK/);
  });
});

describe("add / remove（注入 job runner，不装真调度）", () => {
  let root: string;
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "svc-add-"));
    calls.length = 0;
    process.env.DIA_SERVICE_HOME = join(root, "services");
    process.env.DIA_JOB_ROOT = join(root, "job");
    process.env.DIA_JOB_ENTRY_DIR = join(root, "entry");
  });
  afterEach(() => {
    delete process.env.DIA_SERVICE_HOME;
    delete process.env.DIA_JOB_ROOT;
    delete process.env.DIA_JOB_ENTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  const repo = (name: string, healthcheck?: Record<string, unknown>) => {
    const dir = join(root, "src", name);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "worker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", "worker"), 0o755);
    if (healthcheck) {
      writeFileSync(join(dir, "bin", "hc"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, "bin", "hc"), 0o755);
    }
    writeFileSync(join(dir, "dia.json"), JSON.stringify(base({ id: name, healthcheck })));
    return dir;
  };

  test("add 装服务任务 + 健康检查任务，写 lock（新 gen）与稳定入口链接", () => {
    const src = repo("example-worker", { cmd: "bin/hc" });
    const r = s.add({ dir: s.serviceDir("example-worker"), from: src, runner, backend: "cron", now: new Date("2026-01-01T00:00:00Z") });
    expect(r).toMatchObject({ id: "example-worker", backend: "cron", dryRun: false, jobs: { service: "svc-example-worker", health: "svc-example-worker-health" } });
    expect(r.entry.kind).toBe("repo");
    expect(r.entry.link).toBe(join(process.env.DIA_JOB_ENTRY_DIR!, "worker"));
    const installs = calls.filter((c) => c[0] === "install").map((c) => c[1]);
    expect(installs).toEqual(["svc-example-worker", "svc-example-worker-health"]);
    const lock = s.readLockFile("example-worker");
    expect(lock.gen).toBe(r.gen);
    expect(Object.keys(lock.files).sort()).toEqual(["bin/hc", "dia.json"]);
    // list 可见
    expect(s.listServices({ hostname: "h", registry: null }).find((x) => x.id === "example-worker")).toMatchObject({ version: "0.1.0", gen: r.gen });
  });

  test("remove 反装两个任务并回收 lock / 稳定入口 / 台账", () => {
    const src = repo("rm-svc", { cmd: "bin/hc" });
    const r = s.add({ dir: s.serviceDir("rm-svc"), from: src, runner, backend: "cron" });
    calls.length = 0;
    const out = s.remove({ id: "rm-svc", runner });
    const uninstalled = calls.filter((c) => c[0] === "uninstall").map((c) => c[1]);
    expect(uninstalled).toContain("svc-rm-svc");
    expect(uninstalled).toContain("svc-rm-svc-health");
    expect(out.removed).toContain(r.entry.link!);
    expect(s.listServices({ hostname: "h", registry: null })).toEqual([]);
  });

  test("重装：先卸旧任务（避免同名任务残留旧 cmd/gen），gen 必变", () => {
    const src = repo("again-svc", { cmd: "bin/hc" });
    const first = s.add({ dir: s.serviceDir("again-svc"), from: src, runner, backend: "cron" });
    calls.length = 0;
    const second = s.add({ dir: s.serviceDir("again-svc"), from: src, runner, backend: "cron" });
    expect(second.gen).not.toBe(first.gen);
    expect(calls[0][0]).toBe("uninstall");
    expect(s.readLockFile("again-svc").gen).toBe(second.gen);
  });

  test("lifecycle.target 不是本机 → 只提示（target_mismatch），不拦安装", () => {
    const src = repo("remote-svc");
    writeFileSync(join(src, "dia.json"), JSON.stringify(base({ id: "remote-svc", lifecycle: { type: "bounded", target: "some-other-host.local" } })));
    const r = s.add({ dir: s.serviceDir("remote-svc"), from: src, runner, backend: "cron" });
    expect(r.target_mismatch).toBe(true);
    expect(r.jobs.health).toBeNull();
  });

  test("dry-run 不写任何调度条目、不写 lock", () => {
    const src = repo("dry-svc", { cmd: "bin/hc" });
    const r = s.add({ dir: s.serviceDir("dry-svc"), from: src, runner, backend: "cron", dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(calls).toEqual([]);
    expect(() => s.readLockFile("dry-svc")).toThrow(/E_NOT_INSTALLED/);
  });

  test("cron 表达不了的 interval → E_BACKEND，不写任何调度条目", () => {
    const src = repo("bad-iv");
    writeFileSync(join(src, "dia.json"), JSON.stringify(base({ id: "bad-iv", lifecycle: { type: "periodic", interval: 420 } })));
    expect(() => s.add({ dir: s.serviceDir("bad-iv"), from: src, runner, backend: "cron" })).toThrow(/E_BACKEND/);
    expect(calls).toEqual([]);
  });

  test("后端探测不到（none）→ E_BACKEND，不静默装半套", () => {
    const src = repo("no-backend");
    expect(() => s.add({ dir: s.serviceDir("no-backend"), from: src, runner, backend: "none" })).toThrow(/E_BACKEND/);
    expect(calls).toEqual([]);
  });

  test("job 安装失败 → 撤掉已装任务，不留半装", () => {
    const src = repo("roll-svc", { cmd: "bin/hc" });
    const n = (args: string[]) => {
      calls.push(args);
      return args[0] === "install" && args[1] === "svc-roll-svc-health" ? { status: 5, stdout: "", stderr: "boom" } : { status: 0, stdout: "", stderr: "" };
    };
    expect(() => s.add({ dir: s.serviceDir("roll-svc"), from: src, runner: n, backend: "cron" })).toThrow(/E_JOB/);
    expect(calls.some((c) => c[0] === "uninstall" && c[1] === "svc-roll-svc")).toBe(true);
    expect(() => s.readLockFile("roll-svc")).toThrow(/E_NOT_INSTALLED/);
  });

  test("detectBackend：显式值优先；未知值报错", () => {
    expect(s.detectBackend({ DIA_SERVICE_BACKEND: "cron" })).toBe("cron");
    expect(s.detectBackend({ DIA_SERVICE_BACKEND: "none" })).toBe("none");
    expect(() => s.detectBackend({ DIA_SERVICE_BACKEND: "upstart" })).toThrow(/E_BACKEND/);
  });

  test("healthShell：timeout 包裹 + 码映射（域外折叠成 1）+ 调 dia service health", () => {
    const svc = s.validateServiceManifest(base({ id: "shell-svc", healthcheck: { cmd: "bin/hc --json" } }));
    const sh = s.healthShell(svc, { entryPath: "/tmp/x", dir: "/tmp/x", gen: "g-1" });
    expect(sh).toContain("timeout");
    expect(sh).toContain("__rc=1");
    expect(sh).toContain("service health --from-wrapper");
    expect(sh).toContain("--gen 'g-1'");
    expect(sh).toContain("DIA_SERVICE_HEALTH_FILE");
    expect(s.serviceShell("/a b/worker")).toBe(`'/a b/worker'`);
  });
});
