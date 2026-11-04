import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let bin: string, session: string;

beforeAll(() => {
  process.env.DIA_BW_AUDIT_CHAIN = "0";
  bin = join(mkdtempSync(join(tmpdir(), "dia-bwbin2-")), "bw");
  copyFileSync(join(import.meta.dir, "fixtures", "fake-bw.sh"), bin);
  chmodSync(bin, 0o755);
  session = join(mkdtempSync(join(tmpdir(), "dia-bwstate2-")), "bw.session");
});

const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_BW_BIN: bin, DIA_BW_SESSION_FILE: session },
});

describe("dia env bw", () => {
  test("unlock → run 只注入映射键，BW_SESSION 不出现", () => {
    expect(run(["env", "bw", "unlock"]).status).toBe(0);
    const r = run(["env", "bw", "run", "--map", "DB_PASS=db", "--", "sh", "-c", "printf '%s|%s' \"$DB_PASS\" \"${BW_SESSION:-none}\""]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("secret-db|none");
  });

  test("未映射的 item 取不到 → 非 0，且不执行命令", () => {
    const r = run(["env", "bw", "run", "--map", "X=missing", "--", "sh", "-c", "echo ran"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("ran");
  });

  test("env run --bw 注入声明键，BW_SESSION 不进子进程", () => {
    expect(run(["env", "bw", "unlock"]).status).toBe(0);
    const r = run(["env", "run", "--bw", "DB_PASS=db", "--", "sh", "-c", "printf '%s|%s' \"$DB_PASS\" \"${BW_SESSION:-none}\""]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("secret-db|none");
  });

  test("lock 之后取用失败（fail-closed）", () => {
    expect(run(["env", "bw", "lock"]).status).toBe(0);
    const r = run(["env", "bw", "run", "--map", "DB_PASS=db", "--", "sh", "-c", "echo ran"]);
    expect(r.status).not.toBe(0);
  });
});
