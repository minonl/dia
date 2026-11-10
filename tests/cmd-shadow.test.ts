import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 内置命令遮蔽 persona 同名命令时必须有提示（否则静默跑错）
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

test("--persona 下命中内置同名命令 → stderr 提示；dia cmd 才跑 persona 的", () => {
  const base = mkdtempSync(join(tmpdir(), "dia-shadow-"));
  const home = join(base, "home"), data = join(base, "data"), agents = join(base, "agents"), src = join(base, "src");
  for (const d of [home, data, agents, join(src, "bin"), join(src, "agents")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "agents", "x.md"), "---\ndescription: x\n---\nx\n");
  writeFileSync(join(src, "bin", "claims.sh"), "#!/bin/sh\necho PERSONA_CLAIMS\n");
  chmodSync(join(src, "bin", "claims.sh"), 0o755);
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "x", version: "0.1.0", hosts: ["opencode"],
    entry: { opencode: "agents/x.md" },
    commands: [{ name: "claims", entry: "bin/claims.sh", runtime: "bash" }],
  }));
  const env = { ...process.env, HOME: home, DIA_HOME: home, DIA_DATA_DIR: data, DIA_OPENCODE_AGENTS_DIR: agents, DIA_CACHE_DIR: join(base, "cache"), DIA_PERSONA: "" };
  const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env });
  expect(run(["persona", "add", "--from", src]).status).toBe(0);

  const shadowed = run(["--persona", "x", "claims"]);
  expect(shadowed.stderr).toContain("内置命令 claims 优先");
  expect(shadowed.stdout).not.toContain("PERSONA_CLAIMS");

  const viaCmd = run(["--persona", "x", "cmd", "claims"]);
  expect(viaCmd.status).toBe(0);
  expect(viaCmd.stdout).toContain("PERSONA_CLAIMS");
});
