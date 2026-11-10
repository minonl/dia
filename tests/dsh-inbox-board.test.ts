import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadLine } from "../kits/dia-msg/dsh/dia-inbox/board.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-board-")); mkdirSync(join(root, "collab", "state"), { recursive: true }); });
const put = (b: any) => writeFileSync(join(root, "collab", "state", "board.json"), JSON.stringify(b));

describe("dsh dia-inbox：只读 board 生成提示", () => {
  test("有未读且新鲜 → 一行提示（含数量与命令）", () => {
    put({ schema: 1, generated_at: new Date().toISOString(), interval_s: 300, undelivered: 3 });
    const l = unreadLine(root);
    expect(l).toContain("3 条未读");
    expect(l).toContain("dia msg inbox");
  });

  test("0 未读 → 空（不打扰）", () => {
    put({ schema: 1, generated_at: new Date().toISOString(), interval_s: 300, undelivered: 0 });
    expect(unreadLine(root)).toBe("");
  });

  test("board 过期 → 提示先刷新", () => {
    put({ schema: 1, generated_at: new Date(Date.now() - 3600_000).toISOString(), interval_s: 300, undelivered: 2 });
    expect(unreadLine(root)).toContain("可能过期");
  });
});
