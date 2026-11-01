import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DUMP = `# composed
- id: preset-dabo
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: dabo
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: hi
      - id: tool-fs-search
        name: '@deepseek-ai/dsh-tool-fs-search'
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
- id: webserver
  config:
    port: 1111
`;

let dsh: any;
let root: string, profileDir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dia-dsh-root-"));
  profileDir = mkdtempSync(join(tmpdir(), "dia-dsh-profile-"));
  // 假 dsh：--dump-config 时打印 fixture
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "dsh"), `#!/usr/bin/env bash\ncat <<'YAML'\n${DUMP}YAML\n`);
  chmodSync(join(bin, "dsh"), 0o755);

  // 假插件：tool-fs-search 必填 config，tool-fs 可选
  const mk = (id: string, required: boolean) => {
    const d = join(root, "node_modules", "@deepseek-ai", `dsh-${id}`, "lib");
    mkdirSync(d, { recursive: true });
    const body = required
      ? `export const Config = (v) => { if (v.x === undefined && v.sampleOverCapGlobResults === undefined) throw new Error("$.sampleOverCapGlobResults missing required value"); return v; };`
      : `export const Config = (v) => v;`;
    writeFileSync(join(d, "index.js"), body + "\n");
  };
  mk("tool-fs-search", true);
  mk("tool-fs", false);
  mk("persona", true);

  process.env.DIA_DSH_BIN = join(bin, "dsh");
  process.env.DIA_DSH_ROOT = root;
  dsh = await import("../src/dsh.ts");
});

describe("dsh preset 自检", () => {
  test("dump 解析：找出 preset 里没写 config 的插件", () => {
    expect(dsh.pluginsWithoutConfig(DUMP, "dabo")).toEqual(["tool-fs-search", "tool-fs"]);
  });

  test("必填插件缺 config → fail，原因可读", () => {
    const r = dsh.checkPreset("dabo", profileDir);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toContain("tool-fs-search 缺必填 config");
    expect(r.issues.join(" ")).not.toContain("tool-fs 缺必填");
  });

  test("没渲染 dsh profile → 跳过，不误报", () => {
    const r = dsh.checkPreset("dabo", join(profileDir, "nope"));
    expect(r.ok).toBe(true);
    expect(r.skipped).toContain("未渲染");
  });
});
