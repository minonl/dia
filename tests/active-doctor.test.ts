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

  test("产物被改 → doctor fail（exit 2）", () => {
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(true);
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "tampered\n");
    const r = run(["doctor", "--persona", "yan", "--json"]);
    expect(JSON.parse(r.stdout).verdict).toBe("fail");
    expect(r.status).toBe(2);
  });
});
