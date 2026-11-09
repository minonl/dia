import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as active from "../src/active.ts";

describe("版本槽位排序（同 semver、不同 commit）", () => {
  test("按安装时间取最新，而不是字符串序", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-slot-"));
    process.env.DIA_ROOT = data;
    const id = "p";
    const oldV = "0.1.0+gebf44eb";   // 字符串更大
    const newV = "0.1.0+g564f4a4";   // 字符串更小但更新
    for (const v of [oldV, newV]) {
      const d = join(data, "personas", id, v);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "dia.lock"), JSON.stringify({ id, version: "0.1.0" }));
    }
    const t = new Date();
    utimesSync(join(data, "personas", id, oldV), new Date(t.getTime() - 60000), new Date(t.getTime() - 60000));
    utimesSync(join(data, "personas", id, newV), t, t);
    expect(active.effective(id)?.version).toBe(newV);
  });
});
