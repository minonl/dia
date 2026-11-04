import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bw: any;
let sock: string, audit: string;

beforeAll(async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "dia-bwbin3-")), "bw");
  copyFileSync(join(import.meta.dir, "fixtures", "fake-bw.sh"), bin);
  chmodSync(bin, 0o755);
  process.env.DIA_BW_BIN = bin;
  process.env.DIA_BW_SESSION_FILE = join(mkdtempSync(join(tmpdir(), "dia-bwstate3-")), "bw.session");
  sock = join(mkdtempSync(join(tmpdir(), "dia-bwsock-")), "bw.sock");
  audit = join(mkdtempSync(join(tmpdir(), "dia-bwaudit-")), "bw.jsonl");
  process.env.DIA_BW_SOCKET = sock;
  process.env.DIA_BW_AUDIT = audit;
  bw = await import("../src/bw.ts");
  bw.unlock();
});

describe("bw broker（常驻）", () => {
  test("broker 取值 + 审计行不含值", async () => {
    const h = await bw.serve();
    try {
      expect(await bw.askBroker({ env: "DB_PASS", item: "db", task: "t-1" })).toBe("secret-db");
      const rows = readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const last = rows[rows.length - 1];
      expect(last.item).toBe("db");
      expect(last.env).toBe("DB_PASS");
      expect(last.task).toBe("t-1");
      expect(last.ok).toBe(true);
      expect(JSON.stringify(last)).not.toContain("secret-db");
    } finally { h.close(); }
    expect(existsSync(sock)).toBe(false);
  });

  test("broker 不在 → askBroker 返回 null（调用方可 fallback）", async () => {
    expect(await bw.askBroker({ item: "db" })).toBeNull();
  });

  test("item 取不到 → broker 返回错误并记失败审计", async () => {
    const h = await bw.serve();
    try {
      await expect(bw.askBroker({ item: "missing" })).rejects.toThrow(/E_BW/);
      const rows = readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows[rows.length - 1].ok).toBe(false);
    } finally { h.close(); }
  });
});
