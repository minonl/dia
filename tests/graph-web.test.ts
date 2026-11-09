import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startDiaServer } from "../packages/graph-web/src/server.ts";

let root: string;
let srv: any;
let base: string, token: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dia-web-"));
  process.env.DIA_ROOT = root;
  spawnSync("bun", [cli, "task", "add", "web 任务", "--prio", "P1"], { env: { ...process.env, DIA_ROOT: root } });
  srv = await startDiaServer({ port: 0 });
  base = srv.url.replace(/\?t=.*/, "");
  token = srv.token;
});
afterAll(async () => { await srv.close(); delete process.env.DIA_ROOT; });

describe("graph-web live 服务（只读/loopback/token）", () => {
  test("无 token / 错 token → 401；正确 header → 200", async () => {
    expect((await fetch(base + "/api/graph")).status).toBe(401);
    expect((await fetch(base + "/api/graph", { headers: { "x-dia-token": "wrong" } })).status).toBe(401);
    const r = await fetch(base + "/api/graph", { headers: { "x-dia-token": token } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.schema).toBe(1);
    expect(j.rev).toBeTruthy();
    expect(j.payload.tasks.length).toBe(1);
  });

  test("rev 短路 304；HTML 可打开；CSP 就位", async () => {
    const r1 = await fetch(base + "/api/graph", { headers: { "x-dia-token": token } });
    const { rev } = await r1.json();
    expect((await fetch(`${base}/api/graph?rev=${rev}`, { headers: { "x-dia-token": token } })).status).toBe(304);
    const html = await fetch(base + "/", { headers: { "x-dia-token": token } });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('id="dia-graph"');
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'self'");
  });

  test("?t= token 换 HttpOnly cookie 并重定向", async () => {
    const r = await fetch(`${base}/?t=${encodeURIComponent(token)}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("set-cookie") || "").toContain("HttpOnly");
  });

  test("localhost 归一 302；跨源 Origin 403", async () => {
    const port = new URL(base).port;
    const r = await fetch(`http://localhost:${port}/api/graph`, { headers: { "x-dia-token": token, host: `localhost:${port}` } });
    expect([200, 302, 421]).toContain(r.status);
    const bad = await fetch(base + "/api/graph", { headers: { "x-dia-token": token, origin: "http://evil.example" } });
    expect(bad.status).toBe(403);
  });

  test("Host 伪造 421；非 GET 405", async () => {
    const r = await fetch(base + "/api/graph", { headers: { "x-dia-token": token, host: "evil.example" } });
    expect(r.status).toBe(421);
    expect((await fetch(base + "/api/graph", { method: "POST", headers: { "x-dia-token": token } })).status).toBe(405);
  });
});

describe("D3 后续：/api/next、SSE、非 TTY", () => {
  test("/api/next 默认与 seats 两种形态", async () => {
    const r = await fetch(base + "/api/next", { headers: { "x-dia-token": token } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.policy).toBe("kahn-v1");
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items[0].id).toBeTruthy();

    const s = await fetch(base + "/api/next?seats=1", { headers: { "x-dia-token": token } });
    expect(s.status).toBe(200);
    const sj = await s.json();
    expect(sj.policy).toBe("seats-v1");
    expect(Array.isArray(sj.seats)).toBe(true);
    expect(Array.isArray(sj.assignments)).toBe(true);

    const bad = await fetch(base + "/api/next?n=0", { headers: { "x-dia-token": token } });
    expect(bad.status).toBe(400);
  });

  test("/api/events 首帧返回 rev", async () => {
    const r = await fetch(base + "/api/events", { headers: { "x-dia-token": token } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/event-stream");
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: rev");
    await reader.cancel();
  });

  test("非 TTY：打码 URL + 0600 URL 文件", async () => {
    const { spawn } = await import("node:child_process");
    const root2 = mkdtempSync(join(tmpdir(), "dia-web-cli-"));
    const child = spawn("bun", [join(import.meta.dir, "..", "packages", "graph-web", "src", "main.ts"), "--port", "0"], {
      env: { ...process.env as any, DIA_ROOT: root2 }, stdio: ["ignore", "pipe", "pipe"],
    });
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("timeout " + buf)), 8000);
      child.stdout!.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/dia graph web: [^\n]+/);
        if (m) { clearTimeout(t); resolve(m[0]); }
      });
    });
    child.kill("SIGTERM");
    expect(line).toContain("t=***");
    const files = readdirSync(join(root2, "export"));
    const f = files.find((x) => x.endsWith(".url"))!;
    expect(f).toBeTruthy();
    const full = readFileSync(join(root2, "export", f), "utf8");
    expect(full).toContain("?t=");
    expect(full).not.toContain("***");
    expect(statSync(join(root2, "export", f)).mode & 0o777).toBe(0o600);
  });
});
