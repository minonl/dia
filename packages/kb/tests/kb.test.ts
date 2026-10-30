import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, search, lint, getDoc } from "../src/index.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dia-kb-"));
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "index.md"), "# 索引\n\n- [规则一](rules/a.md)\n");
  writeFileSync(join(root, "rules/a.md"), "---\nreview_by: 2020-01-01\n---\n# 规则一\n\n知识库预算 token 压力。\n\n[坏链](nope.md)\n");
  writeFileSync(join(root, "rules/b.md"), "# 规则二\n\n会话采集与脱敏。\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("kb", () => {
  test("index + search (CJK >=3 chars)", async () => {
    const db = join(root, ".idx.db");
    const res = await buildIndex(root, db);
    expect(res.docs).toBe(3);
    const rows = await search(root, "知识库预算", db);
    expect(rows[0]?.path).toBe("rules/a.md");
  });

  test("search short CJK falls back to LIKE", async () => {
    const db = join(root, ".idx.db");
    await buildIndex(root, db);
    const rows = await search(root, "脱敏", db);
    expect(rows[0]?.path).toBe("rules/b.md");
  });

  test("lint reports coverage, review, broken links", async () => {
    const db = join(root, ".idx.db");
    await buildIndex(root, db);
    const res = await lint(root, db);
    expect(res.docs).toBe(3);
    expect(res.index_missing).toContain("rules/b.md");
    expect(res.review_missing).toBe(2);
    expect(res.review_overdue.length).toBe(1);
    expect(res.broken_links.length).toBe(1);
  });

  test("get with section", () => {
    const text = getDoc(root, "rules/a.md", "规则一");
    expect(text).toContain("知识库预算");
    expect(text.split("知识库预算")[0]).not.toContain("坏链");
  });

  test("get rejects path escape", () => {
    expect(() => getDoc(root, "../escape.md")).toThrow();
  });
});
