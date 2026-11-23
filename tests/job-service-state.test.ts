import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// #232：service 类型被 KeepAlive 重启/停机（130/137/143）属正常生命周期，
// 不该记 failed；但崩溃（其它非 0）必须仍可见；exit=0 必须仍记 ok（doctor 检查 8）。
const script = join(import.meta.dir, "..", "packages", "job", "bin", "dia-job");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "diajob-svc-"));
  const env = { ...process.env, DIA_JOB_ROOT: root, DIA_JOB_NO_LAUNCHD: "1" };
  const run = (args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8", env });
  const install = (name: string, cmd: string, extra: string[]) => {
    const r = run(["install", name, "--cmd", cmd, "--desc", "test", "--allow-unstable", ...extra]);
    expect(r.status).toBe(0);
  };
  const exec = (name: string) => {
    const r = spawnSync("bash", [join(root, "tasks", `${name}.sh`)], { encoding: "utf8", env });
    return r.status;
  };
  const lastState = (name: string) => {
    const f = join(root, "tasks", `${name}.state.jsonl`);
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  };
  return { root, env, run, install, exec, lastState };
}

describe("dia-job service 退出态（#232）", () => {
  test("service + SIGTERM(143) → stopped（不再假红）", () => {
    const s = sandbox();
    s.install("svc-term", "exit 143", ["--type", "service"]);
    expect(s.exec("svc-term")).toBe(143);
    expect(s.lastState("svc-term")).toMatchObject({ exit: 143, verdict: "stopped", type: "service" });
  });

  test("service + exit 0 → ok（不制造新的假成功，守住 doctor 检查 8）", () => {
    const s = sandbox();
    s.install("svc-ok", "exit 0", ["--type", "service"]);
    expect(s.exec("svc-ok")).toBe(0);
    expect(s.lastState("svc-ok")).toMatchObject({ exit: 0, verdict: "ok", type: "service" });
  });

  test("service + 崩溃(exit 1) → 仍记 failed（崩溃必须可见）", () => {
    const s = sandbox();
    s.install("svc-crash", "exit 1", ["--type", "service"]);
    expect(s.exec("svc-crash")).toBe(1);
    expect(s.lastState("svc-crash")).toMatchObject({ exit: 1, verdict: "failed", type: "service" });
  });

  test("periodic + 143 → 仍记 failed（不放松真实失败）", () => {
    const s = sandbox();
    s.install("per-term", "exit 143", ["--interval", "300"]);
    expect(s.exec("per-term")).toBe(143);
    expect(s.lastState("per-term")).toMatchObject({ exit: 143, verdict: "failed", type: "periodic" });
  });

  test("生成的 wrapper 带 _JOB_TYPE（存量重装可修好旧文件）", () => {
    const s = sandbox();
    s.install("svc-marker", "exit 0", ["--type", "service"]);
    const w = readFileSync(join(s.root, "tasks", "svc-marker.sh"), "utf8");
    expect(w).toContain("_JOB_TYPE='service'");
  });
});
