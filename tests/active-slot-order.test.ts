import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as active from "../src/active.ts";

const prevRoot = process.env.DIA_ROOT;
afterEach(() => { if (prevRoot === undefined) delete process.env.DIA_ROOT; else process.env.DIA_ROOT = prevRoot; });

describe("版本槽位排序（同 semver、不同 commit）", () => {
  test("按安装时间取最新，而不是字符串序", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-slot-"));
    process.env.DIA_ROOT = data;
    const id = "p";
    const oldV = "0.1.0+gebf44eb";   // 字符串更大
    const newV = "0.1.0+g564f4a4";   // 字符串更小但更新
    const oldAt = new Date(Date.now() - 60000).toISOString();
    const newAt = new Date().toISOString();
    for (const [v, at] of [[oldV, oldAt], [newV, newAt]] as const) {
      const d = join(data, "personas", id, v);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "dia.lock"), JSON.stringify({ id, version: "0.1.0", installedAt: at }));
    }
    expect(active.effective(id)?.version).toBe(newV);
  });
});
