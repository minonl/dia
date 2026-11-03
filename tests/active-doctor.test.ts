import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let home: string, data: string, src: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_HOME: home, DIA_DATA_DIR: data, DIA_OPENCODE_AGENTS_DIR: join(home, ".config/opencode/agents"), DIA_CACHE_DIR: join(data, "cache"), DIA_OPENCODE_CONFIG: join(home, "opencode.json"), ...env },
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-act-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-act-data-"));
  src = mkdtempSync(join(tmpdir(), "dia-act-src-"));
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "agents", "yan.md"), "---\ndescription: yan\nmode: primary\n---\nYou are yan.\n");
  writeFileSync(join(home, "opencode.json"), JSON.stringify({ model: "m" }, null, 2) + "\n");
});

function writePersona(version: string) {
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "yan", version, hosts: ["opencode"], entry: { opencode: "agents/yan.md" },
    files: [{ from: "agents/yan.md", to: "~/.config/opencode/AGENTS.md" }],
  }));
}

describe("生效版本指针（A）", () => {
  test("装两个版本，默认生效最新", () => {
    writePersona("0.1.0"); expect(run(["persona", "add", "--from", src]).status).toBe(0);
    writePersona("0.2.0"); expect(run(["persona", "add", "--from", src]).status).toBe(0);
    const r = run(["persona", "show", "yan"], { DIA_PERSONA: "yan" });
    expect(r.stdout).toContain("0.2.0");
    expect(r.stdout).toContain("最新安装");
  });

  test("use 指定旧版本 → 指针生效 + 写审计", () => {
    const r = run(["persona", "use", "yan@0.1.0", "--reason", "回滚演练"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("→ 0.1.0");
    const audit = readFileSync(join(data, "state", "active.jsonl"), "utf8").trim().split("\n");
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]).reason).toBe("回滚演练");
  });

  test("scope 跟着 active 指针走，而不是最新", () => {
    const r = run(["kb", "get", "x.md"], { DIA_PERSONA: "yan" });
    // 用 persona show 的生效来源断言更直接
    expect(run(["persona", "show", "yan"]).stdout).toContain("active 指针");
  });

  test("use 未安装的版本 → E_VERSION", () => {
    const r = run(["persona", "use", "yan@9.9.9"]);
    expect(r.status).toBe(21);
    expect(r.stderr).toContain("E_VERSION");
  });
});

describe("dia doctor", () => {
  test("全绿时 verdict=ok（default_agent 未设 → warn）", () => {
    run(["persona", "default", "yan"]);
    const r = run(["doctor", "--persona", "yan", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.persona).toBe("yan");
    expect(d.checks.find((c: any) => c.name === "persona.verify").status).toBe("ok");
    expect(d.checks.find((c: any) => c.name === "default_agent").status).toBe("ok");
    expect(r.status).toBeLessThanOrEqual(1);
  });

  test("平台版本自检：opencode/dsh 只报告，不判红", () => {
    const r = run(["doctor", "--json"]);
    const d = JSON.parse(r.stdout);
    for (const name of ["platform:opencode", "platform:dsh"]) {
      const c = d.checks.find((x: any) => x.name === name);
      expect(c).toBeTruthy();
      expect(["ok", "warn"]).toContain(c.status);
    }
    expect(d.verdict).not.toBe("fail");
  });

  test("产物被改 → doctor fail（exit 2）", () => {
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(true);
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "tampered\n");
    const r = run(["doctor", "--persona", "yan", "--json"]);
    expect(JSON.parse(r.stdout).verdict).toBe("fail");
    expect(r.status).toBe(2);
  });

  test("多 persona 且不指定 → 逐个自检，不再整体 E_SCOPE fail", () => {
    // 上一条故意改坏了 AGENTS.md，先恢复，免得本用例被它带成 fail
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), ["---", "description: yan", "mode: primary", "---", "You are yan.", ""].join("\n"));
    const src2 = mkdtempSync(join(tmpdir(), "dia-act-src2-"));
    mkdirSync(join(src2, "agents"), { recursive: true });
    writeFileSync(join(src2, "agents", "dabo.md"), "---\ndescription: dabo\n---\nYou are dabo.\n");
    writeFileSync(join(src2, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "dabo", version: "0.1.0", hosts: ["opencode"], entry: { opencode: "agents/dabo.md" },
    }));
    expect(run(["persona", "add", "--from", src2]).status).toBe(0);

    const r = run(["doctor", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.personas.sort()).toEqual(["dabo", "yan"]);
    expect(d.checks.some((c: any) => c.name === "scope")).toBe(false);
    expect(d.checks.some((c: any) => c.name === "yan.persona")).toBe(true);
    expect(d.checks.some((c: any) => c.name === "dabo.persona")).toBe(true);
    expect(d.checks.filter((c: any) => c.name === "default_agent").length).toBe(1);
    expect(r.status).toBeLessThanOrEqual(1);

    run(["persona", "remove", "dabo"]);
  });
});

describe("persona check / update", () => {
  beforeAll(() => {
    // 前一个 describe 故意改坏了 AGENTS.md，这里恢复（重建 persona 树里的原件）
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), ["---", "description: yan", "mode: primary", "---", "You are yan.", ""].join("\n"));
  });

  test("本地目录安装 → relation=local-only", () => {
    const r = run(["persona", "check", "yan", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.relation).toBe("local-only");
    expect(d.verify_ok).toBe(true);
    expect(r.status).toBe(0);
  });

  test("本地目录安装 → update 从记录的本地源重装（不报错）", () => {
    const r = run(["persona", "update", "yan", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).installed.id).toBe("yan");
  });

  test("内容被改 → check 返回 2", () => {
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "tampered\n");
    expect(run(["persona", "check", "yan"]).status).toBe(2);
  });
});
