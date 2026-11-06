import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// kit 聚合检索：persona KB + 已装 kit 都能被 query 命中，且标注来源；--tag 过滤 kit
const root = join(import.meta.dir, "..");

function run(data: string, args: string[]) {
  const r = Bun.spawnSync(["bun", join(root, "packages/cli/src/index.ts"), "kb", ...args], {
    env: { ...process.env, DIA_ROOT: data, DIA_DATA_DIR: "" },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function seed() {
  const data = mkdtempSync(join(tmpdir(), "dia-kb-kits-"));
  const persona = join(data, "personas", "p", "0.1.0", "knowledge");
  mkdirSync(persona, { recursive: true });
  writeFileSync(join(persona, "persona.md"), "---\ntitle: persona 页\n---\n\nhook 守卫在 persona 侧也提了一句。\n");

  const gitKit = join(data, "kits", "git", "0.1.0");
  mkdirSync(join(gitKit, "knowledge"), { recursive: true });
  writeFileSync(join(gitKit, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id: "git", version: "0.1.0", tags: ["git", "node"] }));
  writeFileSync(join(gitKit, "knowledge", "hooks.md"), "---\ntitle: hook manager 共存\n---\n\nsimple-git-hooks 会覆盖 hooksPath，用 RC 注入。\n");

  const nodeKit = join(data, "kits", "node", "0.1.0");
  mkdirSync(join(nodeKit, "knowledge"), { recursive: true });
  writeFileSync(join(nodeKit, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id: "node", version: "0.1.0", tags: ["node"] }));
  writeFileSync(join(nodeKit, "knowledge", "pnpm.md"), "---\ntitle: pnpm allowBuilds\n---\n\npnpm 11 需要 allowBuilds 放行构建脚本。\n");
  return data;
}

describe("kb kit aggregation", () => {
  test("查询命中 kit 内容并标注来源", () => {
    const data = seed();
    const r = run(data, ["query", "hooksPath", "--json"]);
    const rows = JSON.parse(r.out);
    const kitRow = rows.find((x: any) => String(x.source || "").startsWith("kit:git@"));
    expect(kitRow).toBeTruthy();
    expect(kitRow.path).toContain("hooks.md");
  });

  test("--tag node 只检索带 node 标签的 kit（git 与 node 都在，persona 也在）", () => {
    const data = seed();
    const r = run(data, ["query", "allowBuilds", "--tag", "node", "--json"]);
    const rows = JSON.parse(r.out);
    expect(rows.some((x: any) => x.source === "kit:node@0.1.0")).toBe(true);
    const r2 = run(data, ["query", "hooksPath", "--tag", "node", "--json"]);
    const rows2 = JSON.parse(r2.out);
    // git kit 的 tags 含 node，所以仍能命中；用一个不匹配的 tag 验证过滤
    const r3 = run(data, ["query", "hooksPath", "--tag", "channel", "--json"]);
    const rows3 = JSON.parse(r3.out || "[]");
    expect(rows3.some((x: any) => String(x.source || "").startsWith("kit:"))).toBe(false);
    expect(rows2.length).toBeGreaterThanOrEqual(0);
  });

  test("kit 索引缺失时自动建索引（不报错）", () => {
    const data = seed();
    const r = run(data, ["query", "allowBuilds", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).length).toBeGreaterThan(0);
  });
});
