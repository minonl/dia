import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 委派 persona 命令时，YAN_REPO_DIR 必须指向源码仓（否则 kb claims/baseline 写进生效快照）
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

test("dia --persona <id> <cmd> 注入 YAN_REPO_DIR=源码仓", () => {
  const base = mkdtempSync(join(tmpdir(), "dia-srcenv-"));
  const home = join(base, "home"), data = join(base, "data"), agents = join(base, "agents"), src = join(base, "src");
  for (const d of [home, data, agents, join(src, "bin"), join(src, "agents")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "agents", "x.md"), "---\ndescription: x\n---\nx\n");
  writeFileSync(join(src, "bin", "showrepo.sh"), "#!/bin/sh\nprintf '%s' \"$YAN_REPO_DIR\"\n");
  chmodSync(join(src, "bin", "showrepo.sh"), 0o755);
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "x", version: "0.1.0", hosts: ["opencode"],
    entry: { opencode: "agents/x.md" },
    commands: [{ name: "showrepo", entry: "bin/showrepo.sh", runtime: "bash" }],
  }));
  const env = { ...process.env, HOME: home, DIA_HOME: home, DIA_DATA_DIR: data, DIA_OPENCODE_AGENTS_DIR: agents, DIA_CACHE_DIR: join(base, "cache"), DIA_PERSONA: "" };
  const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env });
  expect(run(["persona", "add", "--from", src]).status).toBe(0);
  const r = run(["--persona", "x", "showrepo"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(src);
});
