import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kit from "../src/kit.ts";

const prevRoot = process.env.DIA_ROOT;
afterEach(() => { if (prevRoot === undefined) delete process.env.DIA_ROOT; else process.env.DIA_ROOT = prevRoot; });

function seed(data: string, id: string, versions: string[]) {
  for (const v of versions) {
    const d = join(data, "kits", id, v);
    mkdirSync(join(d, "knowledge"), { recursive: true });
    writeFileSync(join(d, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id, version: v, knowledge: ["knowledge"] }));
    writeFileSync(join(d, "knowledge", "a.md"), `---\ntitle: ${id} ${v}\n---\n\nx\n`);
  }
}

function seedLock(data: string, persona: string, kits: { id: string; version: string }[]) {
  const d = join(data, "personas", persona, "0.1.0+glocal");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "dia.lock"), JSON.stringify({ id: persona, version: "0.1.0", kits }));
}

describe("kit gc", () => {
  test("保最近 N 个 + persona 引用的版本", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-kitgc-"));
    process.env.DIA_ROOT = data;
    seed(data, "x", ["0.1.0", "0.2.0", "0.3.0"]);
    seedLock(data, "p", [{ id: "x", version: "0.1.0" }]);
    const r = kit.gc({ keep: 1 });
    // 0.3.0 = 最新，0.1.0 = persona 引用；0.2.0 应被回收
    expect(r.removed.map((x) => x.version)).toEqual(["0.2.0"]);
    expect(existsSync(join(data, "kits", "x", "0.2.0"))).toBe(false);
    expect(existsSync(join(data, "kits", "x", "0.1.0"))).toBe(true);
    expect(existsSync(join(data, "kits", "x", "0.3.0"))).toBe(true);
  });

  test("dry-run 不删", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-kitgc-dry-"));
    process.env.DIA_ROOT = data;
    seed(data, "y", ["0.1.0", "0.2.0"]);
    const r = kit.gc({ keep: 1, dryRun: true });
    expect(r.removed.map((x) => x.version)).toEqual(["0.1.0"]);
    expect(existsSync(join(data, "kits", "y", "0.1.0"))).toBe(true);
  });

  test("全部被引用时一个都不删", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-kitgc-keep-"));
    process.env.DIA_ROOT = data;
    seed(data, "z", ["0.1.0", "0.2.0"]);
    seedLock(data, "p", [{ id: "z", version: "0.1.0" }, { id: "z", version: "0.2.0" }]);
    expect(kit.gc({ keep: 1 }).removed).toEqual([]);
  });
});
