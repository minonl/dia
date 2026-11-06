import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// kit 清单 tags（双标签）：list() 应带出来，供 persona 引用与检索
const root = join(import.meta.dir, "..");

function runList(data: string) {
  const r = Bun.spawnSync(["bun", join(root, "packages/cli/src/index.ts"), "kit", "list", "--json"], {
    env: { ...process.env, DIA_ROOT: data, DIA_DATA_DIR: "" },
    stdout: "pipe", stderr: "pipe",
  });
  return JSON.parse(r.stdout.toString() || "[]");
}

describe("kit tags", () => {
  test("list() 输出 tags（取最新版本清单）", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-kit-tags-"));
    const dir = join(data, "kits", "git", "0.1.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify({
      schema: 1, kind: "kit", id: "git", version: "0.1.0", tags: ["git", "node", "hooks"],
    }));
    const rows = runList(data);
    const hit = rows.find((x: any) => x.id === "git");
    expect(hit?.tags).toEqual(["git", "node", "hooks"]);
  });

  test("无 tags 的 kit 不崩，返回空数组", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-kit-tags-none-"));
    const dir = join(data, "kits", "plain", "0.1.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id: "plain", version: "0.1.0" }));
    const rows = runList(data);
    expect(rows.find((x: any) => x.id === "plain")?.tags).toEqual([]);
  });

  test("manifest 损坏不影响 list", () => {
    const data = mkdtempSync(join(tmpdir(), "dia-kit-tags-bad-"));
    const dir = join(data, "kits", "broken", "0.1.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), "{not json");
    const rows = runList(data);
    expect(rows.find((x: any) => x.id === "broken")?.tags).toEqual([]);
  });
});
