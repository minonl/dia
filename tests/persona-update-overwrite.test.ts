import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// dia 托管产物内容变化 → update 应自动覆盖（先备份），不再要求 --force
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

test("persona update 免 --force 覆盖托管产物并备份", () => {
  const base = mkdtempSync(join(tmpdir(), "dia-upo-"));
  const home = join(base, "home"), data = join(base, "data"), agents = join(base, "agents"), src = join(base, "src");
  for (const d of [home, data, agents, join(src, "agents")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "AGENTS.md"), "---\ndescription: x\n---\nv1\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "x", version: "0.1.0", hosts: ["opencode"],
    entry: { opencode: "AGENTS.md" },
  }));
  // 本地源码也要是 git 仓：内容变化 → 新 slot（否则同 slot 会 E_VERSION_COLLISION，与本题无关）
  const git = (args: string[]) => spawnSync("git", ["-C", src, ...args], { encoding: "utf8" });
  git(["init", "-q"]); git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v1"]);
  const env = { ...process.env, HOME: home, DIA_HOME: home, DIA_DATA_DIR: data, DIA_OPENCODE_AGENTS_DIR: agents, DIA_CACHE_DIR: join(base, "cache"), DIA_PERSONA: "" };
  const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env });
  expect(run(["persona", "add", "--from", src]).status).toBe(0);
  const dest = join(agents, "x.md");
  expect(readFileSync(dest, "utf8")).toContain("v1");

  writeFileSync(join(src, "AGENTS.md"), "---\ndescription: x\n---\nv2\n");
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "v2"]);
  const up = run(["persona", "update", "x"]);
  if (up.status !== 0) console.error(up.stdout, up.stderr);
  expect(up.status).toBe(0);
  expect(readFileSync(dest, "utf8")).toContain("v2");
  expect(run(["persona", "verify", "x"]).status).toBe(0);
  const backups = join(data, "backups");
  expect(existsSync(backups) && readdirSync(backups).length > 0).toBe(true);
});
