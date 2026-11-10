import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// update 必须按 manifest 的全部 hosts 重渲染（旧实现只渲染 opencode → dsh profile 不刷新）
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

test("persona update 同时刷新 opencode 与 dsh 产物", () => {
  const base = mkdtempSync(join(tmpdir(), "dia-upd-"));
  const home = join(base, "home"), data = join(base, "data"), agents = join(base, "agents"), profiles = join(base, "profiles"), src = join(base, "src");
  for (const d of [home, data, agents, profiles, join(src, "agents"), join(src, "platform/dsh/bot")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "agents", "bot.md"), "---\ndescription: bot\n---\nv1\n");
  writeFileSync(join(src, "platform/dsh/bot/cordis.yml"), "[]\n");
  writeFileSync(join(src, "platform/dsh/bot/cordis.patch.yml"), "[]\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "bot", version: "0.1.0",
    hosts: ["opencode", "dsh"], entry: { opencode: "agents/bot.md", dsh: "platform/dsh/bot" },
  }));
  const env = { ...process.env, HOME: home, DIA_HOME: home, DIA_DATA_DIR: data, DIA_OPENCODE_AGENTS_DIR: agents, DIA_DSH_PROFILES_DIR: profiles, DIA_CACHE_DIR: join(base, "cache"), DIA_PERSONA: "" };
  const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env });

  expect(run(["persona", "add", "--from", src]).status).toBe(0);
  const dshProfile = join(profiles, "bot");
  expect(existsSync(join(dshProfile, "cordis.patch.yml"))).toBe(true);

  writeFileSync(join(src, "agents", "bot.md"), "---\ndescription: bot\n---\nv2\n");
  writeFileSync(join(src, "platform/dsh/bot/cordis.patch.yml"), "# v2\n[]\n");
  const up = run(["persona", "update", "bot", "--force"]);
  if (up.status !== 0) console.error(up.stdout, up.stderr);
  expect(up.status).toBe(0);
  expect(readFileSync(join(agents, "bot.md"), "utf8")).toContain("v2");
  expect(readFileSync(join(dshProfile, "cordis.patch.yml"), "utf8")).toContain("# v2");
});
