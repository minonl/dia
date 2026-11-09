import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
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
