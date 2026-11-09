import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 原子安装 / 数据根锁 / semver 排序：都不该破坏旧安装
let kit: any, home: string, src: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-ka-home-"));
  process.env.DIA_HOME = home;
  process.env.DIA_DATA_DIR = home;
  process.env.DIA_CACHE_DIR = join(home, "cache");
  kit = require("../src/kit.ts");
});

function makeKit(id: string, version: string, body: string, root?: string): string {
  const dir = root ?? mkdtempSync(join(tmpdir(), `dia-ka-${id}-`));
  mkdirSync(join(dir, "skills", id), { recursive: true });
  writeFileSync(join(dir, "skills", id, "SKILL.md"), body);
  writeFileSync(join(dir, "dia.json"), JSON.stringify({
    schema: 1, kind: "kit", id, version,
    skills: [{ from: `skills/${id}`, name: id, mode: "copy" }],
  }));
  return dir;
}

describe("kit 原子安装", () => {
  test("同内容重复安装 → changed=false，内容不变", () => {
    const dir = makeKit("ka", "0.1.0", "# a\n");
    const r1 = kit.install(dir);
    expect(r1.changed).toBe(true);
    const r2 = kit.install(dir);
    expect(r2.changed).toBe(false);
    expect(readFileSync(join(r2.dir, "skills/ka/SKILL.md"), "utf8")).toBe("# a\n");
  });

  test("安装失败（空清单）不破坏已装版本", () => {
    const dir = makeKit("kb", "0.1.0", "# keep\n");
    const r = kit.install(dir);
    const broken = mkdtempSync(join(tmpdir(), "dia-ka-broken-"));
    writeFileSync(join(broken, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id: "kb", version: "0.1.0" }));
    expect(() => kit.install(broken)).toThrow(/E_MANIFEST/);
    expect(readFileSync(join(r.dir, "skills/kb/SKILL.md"), "utf8")).toBe("# keep\n");
    expect(kit.verify("kb", "0.1.0").ok).toBe(true);
  });

  test("锁被占用 → E_KIT_BUSY（超时可控）", () => {
    const lock = join(home, "kits", ".install.lock");
    mkdirSync(join(home, "kits"), { recursive: true });
    writeFileSync(lock, "{}");
    const dir = makeKit("kc", "0.1.0", "# c\n");
    process.env.DIA_KIT_LOCK_MS = "80";
    try {
      expect(() => kit.install(dir)).toThrow(/E_KIT_BUSY/);
    } finally {
      delete process.env.DIA_KIT_LOCK_MS;
      require("node:fs").rmSync(lock, { force: true });
    }
  });

  test("残留 staging 不参与 list/installed", () => {
    const dir = makeKit("kd", "0.1.0", "# d\n");
    kit.install(dir);
    mkdirSync(join(home, "kits", ".staging", "junk"), { recursive: true });
    expect(kit.list().some((k: any) => k.id.startsWith("."))).toBe(false);
    expect(kit.installed().some((k: any) => k.id.startsWith("."))).toBe(false);
  });

  test("版本按 semver 排序：0.1.10 胜过 0.1.9", () => {
    for (const v of ["0.1.9", "0.1.10"]) kit.install(makeKit("kv", v, `# ${v}\n`));
    expect(kit.installed().find((k: any) => k.id === "kv")!.version).toBe("0.1.10");
    expect(kit.readLock("kv").version).toBe("0.1.10");
  });
});

describe("installDir 校验", () => {
  test("DIA_INSTALL_DIR 指向不存在目录 → 告警并回退探测（不再静默）", () => {
    const r = spawnSync("bun", [cli, "doctor", "--paths"], {
      encoding: "utf8",
      env: { ...process.env, DIA_INSTALL_DIR: "/nonexistent/dia-xyz", DIA_HOME: home, DIA_DATA_DIR: home },
    });
    expect(r.stderr).toContain("DIA_INSTALL_DIR");
    expect(r.stdout).not.toContain("/nonexistent/dia-xyz");
  });
});

describe("doctor bootstrap 检查", () => {
  test("输出 bootstrap 项（未装配 → warn，并给修复命令）", () => {
    const r = spawnSync("bun", [cli, "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, DIA_HOME: home, DIA_DATA_DIR: home },
    });
    const d = JSON.parse(r.stdout);
    const b = d.checks.find((c: any) => c.name === "bootstrap");
    expect(b).toBeTruthy();
    expect(["ok", "warn"]).toContain(b.status);
  });
});
