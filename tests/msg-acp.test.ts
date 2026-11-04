import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let agentsRoot: string, msgRoot: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const mock = join(import.meta.dir, "fixtures", "mock-acp.mjs");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_AGENTS_ROOT: agentsRoot, DIA_MSG_ROOT: msgRoot, DIA_ACP_TIMEOUT: "15000" },
});

beforeAll(() => {
  agentsRoot = mkdtempSync(join(tmpdir(), "dia-acp-ag-"));
  msgRoot = mkdtempSync(join(tmpdir(), "dia-acp-msg-"));
});

describe("dia msg ACP 传输", () => {
  test("登记 acp_cmd 后可投递并落 reply", () => {
    const reg = run(["agents", "register", "--agent", "mock", "--host", "dsh", "--cwd", "/tmp", "--acp-cmd", `node ${mock}`]);
    expect(reg.status).toBe(0);
    const id = JSON.parse(run(["msg", "send", "mock", "--from", "ops", "--kind", "question", "--subject", "s", "--json"]).stdout).id;
    const d = run(["msg", "deliver", "mock", id, "--transport", "acp", "--json"]);
    expect(d.status).toBe(0);
    expect(JSON.parse(d.stdout).reply).toContain("已处理");
    const inbox = JSON.parse(run(["msg", "inbox", "mock", "--json"]).stdout);
    expect(inbox[0].state).toBe("replied");
  });

  test("未登记 acp_cmd 时报 E_NO_ACP", () => {
    run(["agents", "register", "--agent", "plain", "--host", "dsh", "--cwd", "/tmp"]);
    const id = JSON.parse(run(["msg", "send", "plain", "--from", "ops", "--kind", "notify", "--subject", "s", "--json"]).stdout).id;
    const d = run(["msg", "deliver", "plain", id, "--transport", "acp"]);
    expect(d.status).not.toBe(0);
    expect(d.stderr).toContain("E_NO_ACP");
  });
});
