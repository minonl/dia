import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

let root: string, msgRoot: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_SESSION_ID: "", OPENCODE_SESSION_ID: "", ...env },
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

  test("tmux deliver 对无 pane 的会话报 E_NO_PANE（不猜通道）", () => {
    run(["agents", "register", "--agent", "ghost", "--host", "codex", "--cwd", "/tmp"]);
    const id = JSON.parse(run(["msg", "send", "--to", "ses_ghost", "--kind", "notify", "--subject", "s", "--json"], { DIA_SESSION_ID: "ses_ops" }).stdout).id;
    const r = run(["msg", "deliver", "ses_ghost", id, "--transport", "tmux", "--wait"], { DIA_SESSION_ID: "ses_ops" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("E_NO_PANE");
    // 状态未被误标
    const shown = JSON.parse(run(["msg", "show", id, "--json"], { DIA_SESSION_ID: "ses_ghost" }).stdout);
    expect(shown.state).toBe("pending");
  });

  test("msg show 返回正文与元信息", () => {
    const id = JSON.parse(run(["msg", "send", "--to", "ses_ops", "--kind", "question", "--subject", "S", "--body", "BODY-X", "--json"], { DIA_SESSION_ID: "ses_reviewer" }).stdout).id;
    const r = run(["msg", "show", id], { DIA_SESSION_ID: "ses_ops" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BODY-X");
    expect(r.stdout).toContain("question");
  });
});
