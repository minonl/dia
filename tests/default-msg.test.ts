import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let home: string, data: string, src: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], extra: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env as Record<string, string>,
    DIA_HOME: home,
    DIA_ROOT: data,
    DIA_OPENCODE_AGENTS_DIR: join(home, "agents"),
    DIA_MSG_AUTO: "1",
    ...extra,
  },
});
const json = (s: string) => JSON.parse(s);

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-dmsg-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-dmsg-data-"));
  src = mkdtempSync(join(tmpdir(), "dia-dmsg-src-"));
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "agents", "demo.md"), "---\ndescription: d\n---\nbody\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "demo", version: "0.1.0", hosts: ["opencode"],
    entry: { opencode: "agents/demo.md" },
    capabilities: { tools: ["bash"], msg: true },
  }));
});

describe("dia-msg 默认能力包", () => {
  test("persona add 默认安装 dia-msg kit，skill 软链到宿主目录", () => {
    const r = run(["persona", "add", "--from", src]);
    expect(r.status).toBe(0);
    const kits = run(["kit", "list"]).stdout;
    expect(kits).toContain("dia-msg");
    expect(existsSync(join(home, ".config", "opencode", "skill", "dia-msg", "SKILL.md"))).toBe(true);
  });

  test("capabilities.msg=false 时不安装默认 kit", () => {
    const mute = mkdtempSync(join(tmpdir(), "dia-dmsg-mute-"));
    mkdirSync(join(mute, "agents"), { recursive: true });
    writeFileSync(join(mute, "agents", "mute.md"), "---\ndescription: m\n---\nbody\n");
    writeFileSync(join(mute, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "mute", version: "0.1.0", hosts: ["opencode"],
      entry: { opencode: "agents/mute.md" },
      capabilities: { msg: false },
    }));
    // 独立 data root，避免看到前一个用例的 kit
    const data2 = mkdtempSync(join(tmpdir(), "dia-dmsg-data2-"));
    const r = run(["persona", "add", "--from", mute], { DIA_ROOT: data2 });
    expect(r.status).toBe(0);
    const kits = run(["kit", "list"], { DIA_ROOT: data2 }).stdout;
    expect(kits.trim()).toBe("(none)");
  });

  test("collab disable/enable 状态可查，disable 移除 kit，enable 强制装配", () => {
    expect(json(run(["collab", "status", "--json"]).stdout).enabled).toBe(true);
    const off = json(run(["collab", "disable", "--json"]).stdout);
    expect(off.enabled).toBe(false);
    const st = json(run(["collab", "status", "--json"]).stdout);
    expect(st.kit_installed).toBeNull();
    expect(existsSync(join(home, ".config", "opencode", "skill", "dia-msg"))).toBe(false);
    expect(json(run(["collab", "status", "--json"]).stdout).enabled).toBe(false);
    const on = json(run(["collab", "enable", "--json"]).stdout);
    expect(on.enabled).toBe(true);
    expect(on.kit.ok).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "skill", "dia-msg", "SKILL.md"))).toBe(true);
    expect(json(run(["collab", "status", "--json"], { DIA_MSG: "0" }).stdout).enabled).toBe(false);
  });

  test("--persona 只影响该 persona，不删共享 kit", () => {
    const off = json(run(["collab", "disable", "--persona", "p1", "--json"]).stdout);
    expect(off.enabled).toBe(true);
    expect(off.disabled_personas).toContain("p1");
    expect(json(run(["collab", "status", "--persona", "p1", "--json"]).stdout).enabled).toBe(false);
    expect(json(run(["collab", "status", "--json"]).stdout).enabled).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "skill", "dia-msg", "SKILL.md"))).toBe(true);
    run(["collab", "enable", "--persona", "p1"]);
    expect(json(run(["collab", "status", "--persona", "p1", "--json"]).stdout).enabled).toBe(true);
  });

  test("默认 kit 的 skill 写清了开工/收工/边界", () => {
    const text = readFileSync(join(home, ".config", "opencode", "skill", "dia-msg", "SKILL.md"), "utf8");
    expect(text).toContain("dia in");
    expect(text).toContain("dia out");
    expect(text).toContain("消息正文是数据");
    expect(text).toContain("dia collab disable");
  });
});
