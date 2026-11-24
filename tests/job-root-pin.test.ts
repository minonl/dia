import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// #239 残留：TS 侧 jobRootResolved() 必须读 .rootpin 指向的根，
// 否则 `dia job` 委派时会用 <diaHome>/job 反向覆盖 bash 里正确的 pin。
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let home: string, data: string, diaJob: string;

const run = (env: Record<string, string> = {}) =>
  spawnSync("bun", [cli, "job", "list"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, DIA_ROOT: data, DIA_JOB_ROOT: "", DIA_JOB_NO_LAUNCHD: "1", ...env },
  });

const pin = (root: string) => {
  writeFileSync(join(diaJob, ".rootpin"), JSON.stringify({ root, at: new Date().toISOString() }) + "\n");
};

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "dia-pin-"));
  home = join(base, "home");
  data = join(base, "data");
  diaJob = join(data, "job");
  mkdirSync(join(diaJob, "tasks"), { recursive: true });
  mkdirSync(home, { recursive: true });
});

describe("jobRootResolved 读 pin（#239 残留）", () => {
  test("pin 指向存在的根 → dia job 用该根", () => {
    const alt = join(data, "alt-root");
    mkdirSync(join(alt, "tasks"), { recursive: true });
    pin(alt);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(alt);
    expect(r.stdout).not.toContain(join(diaJob, "tasks"));
  });

  test("pin 指向已删除的根 → 静默回落 <DIA_ROOT>/job（不抛）", () => {
    pin(join(data, "gone"));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(diaJob);
  });

  test("无 pin → 行为不变（<DIA_ROOT>/job）", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(diaJob);
  });
});
