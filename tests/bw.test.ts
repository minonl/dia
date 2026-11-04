import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bw: any;
const fakeSrc = join(import.meta.dir, "fixtures", "fake-bw.sh");

beforeAll(async () => {
  process.env.DIA_BW_AUDIT_CHAIN = "0";
  const bin = join(mkdtempSync(join(tmpdir(), "dia-bwbin-")), "bw");
  copyFileSync(fakeSrc, bin);
  chmodSync(bin, 0o755);
  process.env.DIA_BW_BIN = bin;
  process.env.DIA_BW_SESSION_FILE = join(mkdtempSync(join(tmpdir(), "dia-bwstate-")), "bw.session");
  bw = await import("../src/bw.ts");
});

describe("bw broker", () => {
  test("status 解析 bw 输出", () => {
    expect(bw.status().status).toBe("unlocked");
  });

  test("unlock 把 session 落盘 0600，且不返回值", () => {
    const r = bw.unlock();
    expect(r.ok).toBe(true);
    const mode = statSync(bw.sessionFile()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(bw.readSession()).toBe("SESSION-TOKEN");
  });

  test("取 item 失败即抛（fail-closed）", () => {
    expect(bw.getItemPassword("db")).toBe("secret-db");
    expect(() => bw.getItemPassword("missing")).toThrow(/E_BW/);
  });

  test("runMapped 只注入映射键，BW_SESSION 不泄漏给子进程", () => {
    const r = bw.runMapped([{ env: "DB_PASS", item: "db" }], "sh",
      ["-c", "printf '%s|%s' \"$DB_PASS\" \"${BW_SESSION:-none}\""]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("secret-db|none");
  });

  test("映射里的 item 取不到 → 整次失败，不执行命令", () => {
    expect(() => bw.runMapped([{ env: "X", item: "missing" }], "sh", ["-c", "echo ran"])).toThrow(/E_BW/);
  });

  test("lock 清掉本地 session", () => {
    const r = bw.lock();
    expect(r.ok).toBe(true);
    expect(bw.readSession()).toBeNull();
  });
});
