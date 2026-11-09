import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexStatus } from "@dia/kb";

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
  // 子进程与当前进程必须看到同一个 cache 根，否则 indexStatus 找不到 CLI 建的索引
  process.env.DIA_CACHE_DIR = join(data, "cache");
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

describe("persona 装/切换后自动建索引（派生物）", () => {
  test("persona add 成功后索引已就绪", async () => {
    const sc = run(["--persona", "x", "doctor", "--json"]);
    // 直接查索引态：装完后不该是 missing
    const slot = readdirSync(join(data, "personas", "x")).sort().pop()!;
    const st = await indexStatus(join(data, "personas", "x", slot, "kb"));
    expect(st.state).toBe("ok");
    expect(sc.status === 0 || sc.status === 1 || sc.status === 2).toBe(true);
  });
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

describe("运行时数据 .data 不进快照", () => {
  test("安装跳过 .data，且不影响 persona verify", () => {
    const src2 = mkdtempSync(join(tmpdir(), "dia-pc-src2-"));
    mkdirSync(join(src2, "agents"), { recursive: true });
    mkdirSync(join(src2, "kb"), { recursive: true });
    mkdirSync(join(src2, ".data", "observability"), { recursive: true });
    writeFileSync(join(src2, ".data", "observability", "kb-calls-2026-10.jsonl"), '{"q":"x"}\n');
    writeFileSync(join(src2, "agents", "y.md"), "---\ndescription: y\nmode: primary\n---\ny\n");
    writeFileSync(join(src2, "kb", "a.md"), "# a\n");
    writeFileSync(join(src2, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "y", version: "0.1.0",
      hosts: ["opencode"], entry: { opencode: "agents/y.md" }, knowledge: ["kb"],
    }));
    const add = run(["persona", "add", "--from", src2]);
    expect(add.status).toBe(0);
    const slot = join(data, "personas", "y", "0.1.0");
    expect(existsSync(join(slot, ".data"))).toBe(false);
    // 运行时再往数据根写，不应让内容哈希漂移
    mkdirSync(join(slot, ".data", "observability"), { recursive: true });
    writeFileSync(join(slot, ".data", "observability", "kb-calls-2026-10.jsonl"), '{"q":"late"}\n');
    const v = run(["persona", "verify", "y"]);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain("ok");
  });
});
