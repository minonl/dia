import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// push 路径：有 pane 尝试注入（成功/忙/回读失败），无 pane 只落邮箱
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const fixture = join(import.meta.dir, "fixtures");
let root: string, bin: string, log: string;
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_HOME: root, DIA_DATA_DIR: root, PATH: `${bin}:${process.env.PATH}`, FAKE_TMUX_LOG: log, ...env },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-inj-"));
  bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  const tmux = join(bin, "tmux");
  writeFileSync(tmux, readFileSync(join(fixture, "fake-tmux.sh")));
  chmodSync(tmux, 0o755);
  log = join(root, "tmux.log");
});

function session(id: string, pane?: string) {
  const dir = join(root, "collab", "sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    schema: 1, session_id: id, host: "opencode", display_name: id, cwd: "/tmp",
    started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    capabilities: ["msg:v2"], address: `session:${id}`,
    ...(pane ? { pane, pane_pid: "123", pane_start: "1", pane_cwd: "/tmp" } : {}),
  }));
}

function msgFiles(id: string): string[] {
  const dir = join(root, "collab", "inbox", id);
  return existsSync(dir) ? [join(dir, "x")] : [];
}

describe("dia msg push", () => {
  test("无 pane → mailbox-only，不调用 tmux", () => {
    session("ses_a");
    const r = run(["msg", "send", "--to", "ses_a", "--session", "ses_b", "--subject", "hi"]);
    if (r.status !== 0) console.error("SEND FAILED:", r.status, r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notified=mailbox-only(no-pane)");
    expect(existsSync(log)).toBe(false);
  });

  test("有 pane + 回读命中 → notified=tmux，写 inject.verified 事件", () => {
    session("ses_a", "%1");
    const r = run(["msg", "send", "--to", "ses_a", "--session", "ses_b", "--subject", "hi"], { FAKE_TMUX_SCENARIO: "idle" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notified=tmux");
    const ev = readFileSync(join(root, "collab", "events", new Date().toISOString().slice(0, 7) + ".jsonl"), "utf8");
    expect(ev).toContain("inject.verified");
  });

  test("忙 → mailbox-only(E_BUSY) 且从未 paste", () => {
    session("ses_a", "%1");
    const r = run(["msg", "send", "--to", "ses_a", "--session", "ses_b", "--subject", "hi"], { FAKE_TMUX_SCENARIO: "busy" });
    expect(r.stdout).toContain("notified=mailbox-only(E_BUSY)");
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(calls).not.toContain("paste-buffer");
  });

  test("pane 前台是 shell → E_NOT_DIA（绝不往 shell 里打字）", () => {
    session("ses_a", "%1");
    const r = run(["msg", "send", "--to", "ses_a", "--session", "ses_b", "--subject", "hi"], { FAKE_TMUX_CMD: "zsh" });
    expect(r.stdout).toContain("notified=mailbox-only(E_NOT_DIA(zsh))");
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(calls).not.toContain("paste-buffer");
  });

  test("回读失败 → E_INJECT_UNVERIFIED，消息仍 pending", () => {
    session("ses_a", "%1");
    const r = run(["msg", "send", "--to", "ses_a", "--session", "ses_b", "--subject", "hi"], { FAKE_TMUX_SCENARIO: "no-readback", DIA_TMUX_INJECT_TIMEOUT_MS: "300" });
    expect(r.stdout).toContain("notified=mailbox-only(E_INJECT_UNVERIFIED)");
    const id = r.stdout.split("\t")[0];
    const shown = JSON.parse(run(["show", id, "--json"]).stdout);
    expect(shown.state).toBe("pending");
    expect(shown.injected_at).toBeUndefined();
  });
});
