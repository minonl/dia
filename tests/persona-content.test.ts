import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// persona 级（非 kit）内容：knowledge / data_root / bash 命令
let home: string, data: string, agents: string, profiles: string, src: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env,
    DIA_HOME: home, DIA_DATA_DIR: data,
    DIA_OPENCODE_AGENTS_DIR: agents, DIA_DSH_PROFILES_DIR: profiles,
    DIA_CACHE_DIR: join(data, "cache"), DIA_PERSONA: "",
  },
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-pc-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-pc-data-"));
  agents = mkdtempSync(join(tmpdir(), "dia-pc-agents-"));
  profiles = mkdtempSync(join(tmpdir(), "dia-pc-profiles-"));
  src = mkdtempSync(join(tmpdir(), "dia-pc-src-"));
  mkdirSync(join(src, "agents"), { recursive: true });
  mkdirSync(join(src, "kb"), { recursive: true });
  mkdirSync(join(src, "bin"), { recursive: true });
  writeFileSync(join(src, "agents", "x.md"), "---\ndescription: x\nmode: primary\n---\nx\n");
  writeFileSync(join(src, "kb", "note.md"), "# 台账\n任务台账用 dabo-task，append-only。\n");
  writeFileSync(join(src, "bin", "tool.sh"),
    "#!/usr/bin/env bash\nprintf 'ARGS:%s DATA:%s\\n' \"$*\" \"${DIA_DATA_ROOT:-none}\"\nexit 3\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "x", version: "0.1.0",
    hosts: ["opencode"], entry: { opencode: "agents/x.md" },
    knowledge: ["kb"], data_root: "~/.x-data",
    commands: [
      { name: "tool", entry: "bin/tool.sh", runtime: "bash" },
      { name: "evil", entry: "../../evil.sh", runtime: "bash" },
      { name: "evilabs", entry: "/tmp/evil.sh", runtime: "bash" },
    ],
  }));
  const r = run(["persona", "add", "--from", src]);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
});

describe("persona 级内容：knowledge / data_root / bash 命令", () => {
  test("kb 索引与检索用 persona 声明的知识根", () => {
    const idx = run(["--persona", "x", "kb", "index"]);
    expect(idx.status).toBe(0);
    const s = run(["--persona", "x", "kb", "search", "台账"]);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain("note.md");
  });

  test("入口越界（../ 或绝对路径）→ E_DELEGATE_SCOPE，不执行", () => {
    for (const cmd of ["evil", "evilabs"]) {
      const r = run(["--persona", "x", cmd]);
      expect(r.stderr).toContain("E_DELEGATE_SCOPE");
      expect(r.status).toBe(31);
    }
  });

  test("bash 命令：不注入命令名、注入 data_root、退出码透传", () => {
    const r = run(["--persona", "x", "tool", "a", "b"]);
    expect(r.stdout).toContain("ARGS:a b");
    expect(r.stdout).toContain("DATA:" + join(home, ".x-data"));
    expect(r.status).toBe(3);
  });
});
