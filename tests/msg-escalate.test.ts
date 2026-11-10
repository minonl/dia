import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const fixture = join(import.meta.dir, "fixtures");
let root: string, bin: string, log: string;
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_HOME: root, DIA_DATA_DIR: root, PATH: `${bin}:${process.env.PATH}`, FAKE_TMUX_LOG: log, ...env },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-esc-"));
  bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), readFileSync(join(fixture, "fake-tmux.sh")));
  chmodSync(join(bin, "tmux"), 0o755);
  log = join(root, "tmux.log");
});

function seed(opts: { id: string; sid: string; ageMs: number; state?: string; pane?: string; requiresReply?: boolean }) {
  const sd = join(root, "collab", "sessions"); mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, `${opts.sid}.json`), JSON.stringify({
    schema: 1, session_id: opts.sid, host: "opencode", display_name: opts.sid, cwd: "/tmp",
    started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    capabilities: ["msg:v2"], address: `session:${opts.sid}`,
    ...(opts.pane ? { pane: opts.pane, pane_pid: "1", pane_start: "1", pane_cwd: "/tmp" } : {}),
  }));
  const dir = join(root, "collab", "inbox", opts.sid); mkdirSync(dir, { recursive: true });
  const created = new Date(Date.now() - opts.ageMs).toISOString();
  writeFileSync(join(dir, `${opts.id}.json`), JSON.stringify({
    schema: 2, id: opts.id, thread_id: "th-x", seq: 1,
    from: { session_id: "ses_from" }, to: { session_id: opts.sid },
    kind: "notify", subject: "s", requires_reply: Boolean(opts.requiresReply),
    created_at: created, state: opts.state || "pending", transport: "file",
  }));
}

describe("msg escalate / retry", () => {
  test("超过 TTL 的 pending → escalated（写事件）", () => {
    seed({ id: "m-old", sid: "ses_a", ageMs: 5 * 3600_000 });
    const r = run(["msg", "escalate", "--due"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("m-old");
    const m = JSON.parse(readFileSync(join(root, "collab", "inbox", "ses_a", "m-old.json"), "utf8"));
    expect(m.state).toBe("escalated");
    const evDir = join(root, "collab", "events");
    const ev = readdirSync(evDir).map((f) => readFileSync(join(evDir, f), "utf8")).join("");
    expect(ev).toContain("escalated");
  });

  test("未到期不升级", () => {
    seed({ id: "m-new", sid: "ses_b", ageMs: 60_000 });
    const r = run(["msg", "escalate", "--due"]);
    expect(r.stdout).toContain("nothing due");
  });

  test("retry：有 pane 则重投并记录 attempts", () => {
    seed({ id: "m-r", sid: "ses_c", ageMs: 60_000, pane: "%1" });
    const r = run(["msg", "retry"], { FAKE_TMUX_SCENARIO: "idle" });
    expect(r.stdout).toContain("notified=tmux");
    const m = JSON.parse(readFileSync(join(root, "collab", "inbox", "ses_c", "m-r.json"), "utf8"));
    expect(m.injected_at).toBeTruthy();
    expect(m.attempts).toBe(1);
  });
});
