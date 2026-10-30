import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildIndex, search, lint, defaultDb } from "../packages/kb/src/index.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dia-kb-index-"));
  writeFileSync(join(root, "index.md"), "# Index\n\n- [a](a.md)\n");
  writeFileSync(join(root, "a.md"), "# A\n\n知识库预算 token 压力。\n");
  return { root, db: join(root, ".idx.db") };
}

describe("kb index semantics", () => {
  test("missing index is explicit, not empty hits", async () => {
    const { root, db } = fixture();
    await expect(search(root, "知识库", db)).rejects.toMatchObject({ code: "E_INDEX_MISSING" });
    await expect(lint(root, db)).rejects.toMatchObject({ code: "E_INDEX_MISSING" });
  });

  test("stale index is explicit", async () => {
    const { root, db } = fixture();
    await buildIndex(root, db);
    writeFileSync(join(root, "b.md"), "# B\n\n新增文件\n");
    await expect(search(root, "新增", db)).rejects.toMatchObject({ code: "E_INDEX_STALE" });
  });

  test("index belongs to root", async () => {
    const { root, db } = fixture();
    await buildIndex(root, db);
    const other = mkdtempSync(join(tmpdir(), "dia-kb-other-"));
    writeFileSync(join(other, "a.md"), "# A\n");
    await expect(search(other, "A", db)).rejects.toMatchObject({ code: "E_INDEX_STALE" });
  });

  test("atomic build leaves no temp db", async () => {
    const { root, db } = fixture();
    await buildIndex(root, db);
    await buildIndex(root, db);
    expect(readdirSync(dirname(db)).filter((x) => x.includes(".tmp-"))).toEqual([]);
    expect((await search(root, "知识库", db)).length).toBeGreaterThan(0);
  });

  test("DIA_CACHE_DIR controls default db", () => {
    const { root } = fixture();
    const old = process.env.DIA_CACHE_DIR;
    const cache = mkdtempSync(join(tmpdir(), "dia-kb-cache-"));
    process.env.DIA_CACHE_DIR = cache;
    try {
      expect(defaultDb(root).startsWith(cache)).toBe(true);
    } finally {
      if (old === undefined) delete process.env.DIA_CACHE_DIR; else process.env.DIA_CACHE_DIR = old;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
