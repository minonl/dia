import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// #233：`persona update --dry-run` 必须只预演（不建版本目录、不切 active、不建索引），
// 且 --dry-run 放在 id 之前也要能识别；未知 flag 至少 warn。
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

function fixture(tag: string) {
  const base = mkdtempSync(join(tmpdir(), `dia-upd-dry-${tag}-`));
  const home = join(base, "home");
  const data = join(base, "data");
  const agents = join(base, "agents");
  const src = join(base, "src");
  for (const d of [home, data, agents, join(src, "agents")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "agents", "bot.md"), "---\ndescription: bot\n---\nv1\n");
  writeFileSync(
    join(src, "dia.json"),
    JSON.stringify({
      schema: 1,
      kind: "persona",
      id: "bot",
      version: "0.1.0",
      hosts: ["opencode"],
      entry: { opencode: "agents/bot.md" },
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    DIA_HOME: home,
    DIA_DATA_DIR: data,
    DIA_OPENCODE_AGENTS_DIR: agents,
    DIA_CACHE_DIR: join(base, "cache"),
    DIA_PERSONA: "",
  };
  const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env });
  const slots = () => {
    const dir = join(data, "personas", "bot");
    return existsSync(dir) ? readdirSync(dir).filter((x) => !x.startsWith(".")) : [];
  };
  const bumpSource = () => {
    writeFileSync(join(src, "agents", "bot.md"), "---\ndescription: bot\n---\nv2\n");
    writeFileSync(
      join(src, "dia.json"),
      JSON.stringify({
        schema: 1,
        kind: "persona",
        id: "bot",
        version: "0.2.0",
        hosts: ["opencode"],
        entry: { opencode: "agents/bot.md" },
      }),
    );
  };
  return { base, data, agents, src, env, run, slots, bumpSource };
}

describe("persona update --dry-run（#233）", () => {
  test("dry-run 不建版本目录、不切 active、不建索引、不渲染产物", () => {
    const f = fixture("basic");
    expect(f.run(["persona", "add", "--from", f.src]).status).toBe(0);
    const before = f.slots();
    expect(before.length).toBe(1);

    f.bumpSource();
    const r = f.run(["persona", "update", "bot", "--dry-run"]);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[dry-run]");
    expect(r.stdout).toContain("0.2.0");

    // 没有新版本目录
    expect(f.slots()).toEqual(before);
    // 渲染产物仍是 v1（dry-run 不写盘）
    expect(readFileSync(join(f.agents, "bot.md"), "utf8")).toContain("v1");
  });

  test("--dry-run 放在 id 之前也能识别（布尔 flag 不吃位置参数）", () => {
    const f = fixture("flagfirst");
    expect(f.run(["persona", "add", "--from", f.src]).status).toBe(0);
    f.bumpSource();
    const r = f.run(["persona", "update", "--dry-run", "bot"]);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("missing id");
    expect(r.stdout).toContain("[dry-run]");
  });

  test("dry-run 之后真实 update 仍生效（回归）", () => {
    const f = fixture("thenreal");
    expect(f.run(["persona", "add", "--from", f.src]).status).toBe(0);
    f.bumpSource();
    expect(f.run(["persona", "update", "bot", "--dry-run"]).status).toBe(0);
    const real = f.run(["persona", "update", "bot", "--force"]);
    if (real.status !== 0) console.error(real.stdout, real.stderr);
    expect(real.status).toBe(0);
    expect(real.stdout).toContain("updated");
    expect(readFileSync(join(f.agents, "bot.md"), "utf8")).toContain("v2");
  });

  test("未知 flag 只 warn、不中断（拼错可见）", () => {
    const f = fixture("unknown");
    expect(f.run(["persona", "add", "--from", f.src]).status).toBe(0);
    const r = f.run(["persona", "update", "bot", "--dry-run-it"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("warn");
    expect(r.stderr).toContain("--dry-run-it");
  });

  test("帮助里列出 --dry-run", () => {
    const f = fixture("help");
    const r = f.run(["persona", "update", "--help"]);
    expect(r.stdout).toContain("--dry-run");
  });
});
