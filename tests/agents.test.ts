import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

let root: string, msgRoot: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root },
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dia-agents-"));
  msgRoot = mkdtempSync(join(tmpdir(), "dia-agents-msg-"));
});

describe("dia agents 注册表", () => {
  test("register / list / unregister", () => {
    expect(run(["agents", "register", "--agent", "reviewer", "--host", "codex", "--cwd", "/tmp"]).status).toBe(0);
    expect(existsSync(join(root, "agents", "reviewer.json"))).toBe(true);
    const list = JSON.parse(run(["agents", "list", "--json"]).stdout);
    expect(list.map((r: any) => r.agent)).toEqual(["reviewer"]);
    // 没有 pane 的记录视为离线，投递必须失败（不猜）
    const off = JSON.parse(run(["agents", "list", "--live", "--json"]).stdout);
    expect(off[0].live).toBe(false);
    expect(run(["agents", "unregister", "reviewer"]).status).toBe(0);
    expect(existsSync(join(root, "agents", "reviewer.json"))).toBe(false);
  });

  test("deliver 对离线 agent 报 E_OFFLINE", () => {
    run(["agents", "register", "--agent", "ghost", "--host", "codex", "--cwd", "/tmp"]);
    const id = JSON.parse(run(["msg", "send", "ghost", "--from", "ops", "--kind", "notify", "--subject", "s", "--json"]).stdout).id;
    const r = run(["msg", "deliver", "ghost", id]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("E_OFFLINE");
    // 状态未被误标
    const inbox = JSON.parse(run(["msg", "inbox", "ghost", "--json"]).stdout);
    expect(inbox[0].state).toBe("pending");
  });

  test("msg show 返回正文与元信息", () => {
    const id = JSON.parse(run(["msg", "send", "ops", "--from", "reviewer", "--kind", "question", "--subject", "S", "--body", "BODY-X", "--json"]).stdout).id;
    const r = run(["msg", "show", "ops", id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BODY-X");
    expect(r.stdout).toContain("question");
  });
});
