import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "src", "cli.ts");

type Fixture = ReturnType<typeof makeFixture>;

/** 每个用例独立 DIA_ROOT/DIA_CODEX_HOME，避免污染真实 persona 安装。 */
function makeFixture(id = "p") {
  const repo = mkdtempSync(join(tmpdir(), "dia-rm-repo-"));
  const root = mkdtempSync(join(tmpdir(), "dia-rm-root-"));
  const home = mkdtempSync(join(tmpdir(), "dia-rm-home-"));
  const env = { ...process.env, DIA_ROOT: root, DIA_CODEX_HOME: home, PATH: process.env.PATH || "/usr/bin:/bin" };
  const run = (args: string[]) => spawnSync(process.execPath, [cli, "persona", ...args], { encoding: "utf8", env });
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });

  spawnSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");

  const commit = (body: string) => {
    writeFileSync(join(repo, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id, version: "0.1.0",
      hosts: ["codex"], entry: { codex: "AGENTS.md" },
    }));
    writeFileSync(join(repo, "AGENTS.md"), body);
    git("add", "-A");
    git("commit", "-qm", body);
  };

  commit("v1\n");
  expect(run(["add", id, "--from", repo, "--host", "codex"]).status).toBe(0);
  commit("v2\n");
  expect(run(["add", id, "--from", repo, "--host", "codex", "--force"]).status).toBe(0);

  const idDir = join(root, "personas", id);
  const slots = readdirSync(idDir).filter((n) => n.startsWith("0.1.0"));
  return { id, root, home, env, run, idDir, slots };
}

const activeFile = (root: string) => join(root, "state", "active.json");
const auditFile = (root: string) => join(root, "state", "active.jsonl");

describe("persona remove --version", () => {
  test("多槽位下 --version <semver> 报 E_VERSION_AMBIGUOUS，不猜也不全删", () => {
    const f: Fixture = makeFixture();
    expect(f.slots.length).toBe(2);
    const r = f.run(["remove", f.id, "--version", "0.1.0"]);
    expect(r.status).toBe(21);
    expect(r.stderr).toContain("E_VERSION_AMBIGUOUS");
    for (const s of f.slots) expect(existsSync(join(f.idDir, s))).toBe(true);
    expect(existsSync(f.idDir)).toBe(true);
  });

  test("--version <exact-slot> 只删目标槽位，保留其它槽位与 idDir", () => {
    const f = makeFixture();
    expect(f.slots.length).toBe(2);
    const [target, other] = f.slots;
    const r = f.run(["remove", f.id, "--version", target]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${f.id}@${target}`);
    expect(existsSync(join(f.idDir, target))).toBe(false);
    expect(existsSync(join(f.idDir, other))).toBe(true);
    expect(existsSync(f.idDir)).toBe(true);
  });

  test("删掉最后一个版本后 idDir 消失", () => {
    const f = makeFixture();
    const [target, last] = f.slots;
    expect(f.run(["remove", f.id, "--version", target]).status).toBe(0);
    const r = f.run(["remove", f.id, "--version", "0.1.0"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${f.id}@${last}`);
    expect(existsSync(f.idDir)).toBe(false);
  });

  test("删除生效版本 → 重指剩余最新并写 reason=remove；删最后一个 → 清 active 条目", () => {
    const f = makeFixture();
    const [oldSlot, newSlot] = f.slots;
    expect(f.run(["use", `${f.id}@${oldSlot}`]).status).toBe(0);
    expect(JSON.parse(readFileSync(activeFile(f.root), "utf8"))[f.id].version).toBe(oldSlot);

    expect(f.run(["remove", f.id, "--version", oldSlot]).status).toBe(0);
    const after = JSON.parse(readFileSync(activeFile(f.root), "utf8"))[f.id];
    expect(after.version).toBe(newSlot);
    const audit = readFileSync(auditFile(f.root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1).reason).toBe("remove");

    expect(f.run(["remove", f.id, "--version", newSlot]).status).toBe(0);
    expect(JSON.parse(readFileSync(activeFile(f.root), "utf8"))[f.id]).toBeUndefined();
  });
});

describe("persona remove CLI 参数契约", () => {
  test("未安装 id + 未知参数 → E_USAGE exit 2（早于安装检查）", () => {
    const f = makeFixture();
    const r = f.run(["remove", "nope", "--nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_USAGE");
    expect(r.stderr).not.toContain("E_NOT_INSTALLED");
  });

  test("--version 缺值 / 空值 → E_USAGE exit 2", () => {
    const f = makeFixture();
    for (const args of [["remove", "nope", "--version"], ["remove", "nope", "--version", ""]]) {
      const r = f.run(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("E_USAGE");
    }
  });
});
