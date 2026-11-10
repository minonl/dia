import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let root: string, srv: any, log: string, url = "";
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8", env: { ...process.env, DIA_ROOT: root, DIA_HOME: root, DIA_DATA_DIR: root, DIA_MSG_WEBHOOK_URL: url, ...env },
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dia-wh-"));
  log = join(root, "wh.log");
  mkdirSync(join(root, "collab", "sessions"), { recursive: true });
  for (const id of ["ses_b", "ses_s"]) {
    writeFileSync(join(root, "collab", "sessions", `${id}.json`), JSON.stringify({
      schema: 1, session_id: id, host: "opencode", display_name: id, cwd: "/tmp",
      started_at: new Date().toISOString(), last_seen: new Date().toISOString(), capabilities: ["msg:v2"], address: `session:${id}`,
    }));
  }
  // 独立进程做服务端（in-process 会被 spawnSync 阻塞，5s 超时）
  const port = 18800 + Math.floor(Math.random() * 100);
  url = `http://127.0.0.1:${port}/`;
  srv = spawn("python3", ["-c", `
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); open(${JSON.stringify(log)},'a').write(self.rfile.read(n).decode()+"\\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',${port}),H).serve_forever()
`], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    const p = spawnSync("curl", ["-s", "-o", "/dev/null", url]);
    if (p.status === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterEach(() => srv?.kill());

describe("webhook transport", () => {
  test("2xx → notified=webhook，服务端收到 payload", () => {
    const r = run(["msg", "send", "--to", "ses_b", "--session", "ses_s", "--subject", "wh", "--body", "x"]);
    expect(r.stdout).toContain("notified=webhook");
    expect(readFileSync(log, "utf8")).toContain('"to":"ses_b"');
  });

  test("服务端不可达 → mailbox-only(E_WEBHOOK*)，消息仍在", () => {
    const r = run(["msg", "send", "--to", "ses_b", "--session", "ses_s", "--subject", "wh", "--body", "x"], { DIA_MSG_WEBHOOK_URL: "http://127.0.0.1:1/" });
    expect(r.stdout).toContain("notified=mailbox-only(E_WEBHOOK");
    const id = r.stdout.split("\t")[0];
    const m = JSON.parse(readFileSync(join(root, "collab", "inbox", "ses_b", `${id}.json`), "utf8"));
    expect(m.state).toBe("pending");
  });
});
