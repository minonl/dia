import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";

let kit: any;
let home: string, src: string;

function buildSrc() {
  const root = mkdtempSync(join(tmpdir(), "dia-kit-src-"));
  mkdirSync(join(root, "core", "knowledge", "rules"), { recursive: true });
  mkdirSync(join(root, "core", "skills", "onboarding"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "core", "knowledge", "rules", "r1.md"), "# R1\n");
  writeFileSync(join(root, "core", "knowledge", "scenes.md"), "# scenes\n");
  writeFileSync(join(root, "core", "skills", "onboarding", "SKILL.md"), "# onboarding\n");
  writeFileSync(join(root, "scripts", "kb"), "#!/bin/sh\necho kb\n");
  chmodSync(join(root, "scripts", "kb"), 0o755);
  writeFileSync(join(root, "dia.json"), JSON.stringify({
    schema: 1, kind: "kit", id: "yan-core", version: "0.1.0", root: ".",
    files: [{ from: "core/knowledge/scenes.md", to: "~/.config/opencode/AGENTS.md" }],
    skills: [{ from: "core/skills/onboarding", name: "onboarding", mode: "link" }],
    bin: [{ from: "scripts/kb", name: "yan-kb" }],
    dirs: ["~/.yan-agent/cache"],
    commands: [{ name: "scene", entry: "scripts/kb" }],
    knowledge: ["core/knowledge"],
  }));
  return root;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dia-kit-home-"));
  process.env.DIA_HOME = home;
  process.env.DIA_DATA_DIR = mkdtempSync(join(tmpdir(), "dia-kit-data-"));
  process.env.DIA_CACHE_DIR = mkdtempSync(join(tmpdir(), "dia-kit-cache-"));
  kit = await import("../src/kit.ts");
  src = buildSrc();
});

describe("kit install", () => {
  test("renderContent：默认冲突拒绝；--force 覆盖并备份", () => {
    const dest = join(home, ".config/opencode/AGENTS.md");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "old\n");
    const m = { files: [{ from: "core/knowledge/scenes.md", to: "~/.config/opencode/AGENTS.md" }] };
    expect(() => kit.renderContent(src, src, m)).toThrow(/E_CONFLICT/);
    kit.renderContent(src, src, m, { force: true });
    expect(readFileSync(dest, "utf8")).toContain("# scenes");
    const bdir = join(process.env.DIA_DATA_DIR!, "backups");
    expect(readdirSync(bdir).length).toBeGreaterThan(0);
    rmSync(dest, { force: true }); // 不影响后续「dry-run 不写」断言
  });

  test("dry-run 不写任何东西", () => {
    const r = kit.install(src, { dryRun: true });
    expect(r.hash).toBeNull();
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(false);
    expect(r.rendered.length).toBeGreaterThan(0);
  });

  test("add 渲染 file / link / dir 三类产物", () => {
    const r = kit.install(src);
    expect(r.id).toBe("yan-core");
    expect(readFileSync(join(home, ".config/opencode/AGENTS.md"), "utf8")).toBe("# scenes\n");
    expect(existsSync(join(home, ".local/bin/yan-kb"))).toBe(true);
    expect(existsSync(join(home, ".agents/skills/onboarding/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".yan-agent/cache"))).toBe(true);
    expect(r.changed).toBe(true);
  });

  test("verify 通过；改一个产物 → drift", () => {
    expect(kit.verify("yan-core").ok).toBe(true);
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "tampered\n");
    const v = kit.verify("yan-core");
    expect(v.ok).toBe(false);
    expect(v.drift.join()).toContain("modified");
  });

  test("手改过的产物拒绝删除，其余删干净", () => {
    const r = kit.remove("yan-core");
    expect(r.skipped.join()).toContain("AGENTS.md");
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, ".local/bin/yan-kb"))).toBe(false);
    expect(existsSync(join(home, ".yan-agent/cache"))).toBe(true); // dirs 保留
    expect(kit.list()).toEqual([]);
  });

  test("re-add 后 remove 无残留", () => {
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "# scenes\n"); // 恢复成包内内容
    kit.install(src);
    const r = kit.remove("yan-core");
    expect(r.skipped).toEqual([]);
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, ".local/bin/yan-kb"))).toBe(false);
    expect(kit.list()).toEqual([]);
  });
});

describe("kit 边界", () => {
  test("目标越出 HOME → 拒绝", () => {
    const bad = mkdtempSync(join(tmpdir(), "dia-kit-bad-"));
    mkdirSync(join(bad, "x"), { recursive: true });
    writeFileSync(join(bad, "x", "a.md"), "# a\n");
    writeFileSync(join(bad, "dia.json"), JSON.stringify({
      schema: 1, kind: "kit", id: "bad", version: "0.1.0",
      files: [{ from: "x/a.md", to: "/tmp/dia-kit-escape.md" }],
    }));
    expect(() => kit.install(bad)).toThrow(/escapes HOME/);
  });

  test("源越出包 → 拒绝", () => {
    const bad = mkdtempSync(join(tmpdir(), "dia-kit-bad2-"));
    writeFileSync(join(bad, "dia.json"), JSON.stringify({
      schema: 1, kind: "kit", id: "bad2", version: "0.1.0",
      files: [{ from: "../../etc/hosts", to: "~/.x" }],
    }));
    expect(() => kit.install(bad)).toThrow(/E_MANIFEST/);
  });

  test("同名文件已被他人占用 → E_CONFLICT，且不半装", () => {
    const other = mkdtempSync(join(tmpdir(), "dia-kit-c-"));
    mkdirSync(join(other, "s"), { recursive: true });
    writeFileSync(join(other, "s", "a.md"), "# mine\n");
    writeFileSync(join(other, "dia.json"), JSON.stringify({
      schema: 1, kind: "kit", id: "conflict", version: "0.1.0",
      files: [{ from: "s/a.md", to: "~/.config/opencode/AGENTS.md" }],
    }));
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "# someone else\n");
    expect(() => kit.install(other)).toThrow(/E_CONFLICT/);
    expect(readFileSync(join(home, ".config/opencode/AGENTS.md"), "utf8")).toBe("# someone else\n");
    expect(kit.list().find((k: any) => k.id === "conflict")).toBeUndefined();
  });

  test("幂等：同版本重装无变化", () => {
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "# scenes\n");
    const r1 = kit.install(src);
    const r2 = kit.install(src);
    expect(r1.hash).toBe(r2.hash);
  });
});


describe("kit 空内容拒绝", () => {
  test("清单未声明任何内容 → E_MANIFEST", () => {
    const root = mkdtempSync(join(tmpdir(), "dia-kit-empty-"));
    writeFileSync(join(root, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id: "empty", version: "0.1.0" }));
    expect(() => kit.install(root)).toThrow(/E_MANIFEST/);
  });
});
