import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// v2 语义：deliver 的目标是会话语义 id（ses_*），pane/acp 信息从会话记录 + agents 登记里取
let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const mock = join(import.meta.dir, "fixtures", "mock-acp.mjs");
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_SESSION_ID: "", OPENCODE_SESSION_ID: "", DIA_ACP_TIMEOUT: "15000", ...env },
});
const json = (s: string) => JSON.parse(s);
const A = { DIA_SESSION_ID: "ses_a" };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dia-acp-"));
  run(["msg", "inbox", "--json"], { DIA_SESSION_ID: "ses_a" });
  run(["msg", "inbox", "--json"], { DIA_SESSION_ID: "ses_mock" });
  run(["msg", "inbox", "--json"], { DIA_SESSION_ID: "ses_async" });
  run(["msg", "inbox", "--json"], { DIA_SESSION_ID: "ses_plain" });
});

describe("dia msg deliver --transport acp（v2）", () => {
  test("登记 acp_cmd 后可投递并落 reply", () => {
    const reg = run(["agents", "register", "--agent", "ses_mock", "--host", "dsh", "--cwd", "/tmp", "--acp-cmd", `node ${mock}`]);
    expect(reg.status).toBe(0);
    const id = json(run(["msg", "send", "--to", "ses_mock", "--kind", "question", "--subject", "s", "--json"], A).stdout).id;
    const d = run(["msg", "deliver", "ses_mock", id, "--transport", "acp", "--wait", "--json"]);
    if (d.status !== 0) console.error(d.stdout, d.stderr);
    expect(d.status).toBe(0);
    expect(json(d.stdout).reply).toContain("已处理");
    const shown = json(run(["msg", "show", id, "--json"], { DIA_SESSION_ID: "ses_mock" }).stdout);
    expect(shown.state).toBe("replied");
  });

  test("默认异步投递：立即返回，后台完成并落 reply", async () => {
    run(["agents", "register", "--agent", "ses_async", "--host", "dsh", "--cwd", "/tmp", "--acp-cmd", `node ${mock}`]);
    const id = json(run(["msg", "send", "--to", "ses_async", "--kind", "question", "--subject", "s", "--json"], A).stdout).id;
    const t0 = Date.now();
    const d = run(["msg", "deliver", "ses_async", id, "--transport", "acp", "--json"]);
    expect(d.status).toBe(0);
    expect(json(d.stdout).dispatched).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    // 异步日志必须落在 v2 目录，不能回 v1 的 ~/.dia/msg/
    expect(json(d.stdout).log).toContain(join("collab", "deliver"));
    let state = "pending";
    for (let i = 0; i < 25 && state !== "replied"; i++) {
      state = json(run(["msg", "show", id, "--json"], { DIA_SESSION_ID: "ses_async" }).stdout).state || "pending";
      if (state !== "replied") await new Promise((r) => setTimeout(r, 200));
    }
    expect(state).toBe("replied");
  });

  test("未登记 acp_cmd 时报 E_NO_ACP", () => {
    run(["agents", "register", "--agent", "ses_plain", "--host", "dsh", "--cwd", "/tmp"]);
    const id = json(run(["msg", "send", "--to", "ses_plain", "--kind", "notify", "--subject", "s", "--json"], A).stdout).id;
    const d = run(["msg", "deliver", "ses_plain", id, "--transport", "acp", "--wait"]);
    expect(d.status).not.toBe(0);
    expect(d.stderr).toContain("E_NO_ACP");
  });

  test("deliver <非会话 id> → 报错", () => {
    const d = run(["msg", "deliver", "someagent", "m-x", "--wait"]);
    expect(d.status).toBe(2);
    expect(d.stderr).toContain("E_USAGE");
  });
});
