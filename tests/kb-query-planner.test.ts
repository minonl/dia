import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, search } from "../packages/kb/src/index.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dia-kb-plan-"));
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "index.md"), "# Index\n\n- [notify](rules/notify.md)\n- [design](rules/design-doc.md)\n");
  writeFileSync(join(root, "rules/notify.md"), "### R30.5. 评审请求消息模板\n\n@ 对方 + 修改概要 + 链接。\n");
  writeFileSync(join(root, "rules/design-doc.md"), "# 设计文档\n\n设计文档产出后自动打开供评审。\n");
  writeFileSync(join(root, "scenes.md"), "# 场景\n\n评审阶段场景。\n");
  return { root, db: join(root, ".idx.db") };
}

describe("kb query planner", () => {
  test("ID token is preferred", async () => {
    const { root, db } = fixture();
    await buildIndex(root, db);
    const rows = await search(root, "R30.5 评审请求消息模板", db);
    expect(rows[0]?.path).toBe("rules/notify.md");
    expect(rows.some((r) => r.path === "rules/design-doc.md")).toBe(true);
  });

  test("CJK phrase falls back to terms", async () => {
    const { root, db } = fixture();
    await buildIndex(root, db);
    const rows = await search(root, "评审请求消息模板", db);
    expect(rows.some((r) => r.path === "rules/why-does-not-exist.md")).toBe(false);
    expect(rows.some((r) => r.path === "rules/notify.md" || r.path === "rules/design-doc.md")).toBe(true);
  });

  test("why is exposed", async () => {
    const { root, db } = fixture();
    await buildIndex(root, db);
    const rows = await search(root, "R30.5", db);
    expect(rows[0]?.why).toBe("id");
  });
});
