import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// dia msg ack/reply/close/show 带 --session 时必须走 v2（v1 要 <agent> <id>）
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let root: string;
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8", env: { ...process.env, DIA_ROOT: root, DIA_HOME: root, DIA_DATA_DIR: root },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-route-"));
  mkdirSync(join(root, "collab", "sessions"), { recursive: true });
  writeFileSync(join(root, "collab", "sessions", "ses_b.json"), JSON.stringify({
    schema: 1, session_id: "ses_b", host: "opencode", display_name: "b", cwd: "/tmp",
    started_at: new Date().toISOString(), last_seen: new Date().toISOString(), capabilities: ["msg:v2"], address: "session:ses_b",
  }));
  const dir = join(root, "collab", "inbox", "ses_b"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "m-x.json"), JSON.stringify({
    schema: 2, id: "m-x", thread_id: "th-x", seq: 1,
    from: { session_id: "ses_a" }, to: { session_id: "ses_b" },
    kind: "question", subject: "s", requires_reply: true,
    created_at: new Date().toISOString(), state: "pending", transport: "file",
  }));
});

describe("dia msg <sub> --session 路由到 v2", () => {
  test("ack", () => {
    const r = run(["msg", "ack", "m-x", "--session", "ses_b"]);
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "collab", "inbox", "ses_b", "m-x.json"), "utf8")).state).toBe("acked");
  });
  test("show --json", () => {
    const r = run(["msg", "show", "m-x", "--session", "ses_b", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).id).toBe("m-x");
  });
});
