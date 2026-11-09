// dia graph live 服务（M2a）：只读 + loopback + 一次性 token 换 cookie
// 设计：docs/design/graph-web-m2.md
// 不做写操作、不做多人共享、不常驻（前台进程，Ctrl-C 退出）。
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { buildPayload, renderHtml } from "../../../src/graph-html/render.ts";
import * as graph from "../../../src/graph.ts";
import * as claims from "../../../src/claims.ts";
import * as task from "../../../src/task.ts";

export interface ServerOptions {
  port?: number;
  /** 覆盖生成时间（测试确定性） */
  now?: Date;
}

const TOKEN_COOKIE = "dia_token";

function sha1(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function revOf(): string {
  try {
    const tasks = task.list();
    const active = claims.list({}).length;
    return sha1(`${tasks.length}:${active}:${tasks.map((t) => `${t.id}${t.status}${t.updated_at}`).join("|")}`).slice(0, 12);
  } catch { return sha1(String(Date.now())).slice(0, 12); }
}

function payloadNow(now?: Date) {
  const g = graph.build();
  return { rev: revOf(), graph: g };
}

export function createDiaServer(opts: ServerOptions = {}) {
  const port = opts.port ?? 0;
  const token = randomBytes(32).toString("base64url");
  const tokenBuf = Buffer.from(token);

  const same = (v: string | undefined) => {
    if (!v) return false;
    const b = Buffer.from(v);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  const cookieToken = (h?: string) => {
    if (!h) return undefined;
    for (const part of h.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === TOKEN_COOKIE) return decodeURIComponent(v.join("="));
    }
    return undefined;
  };
  const authorized = (req: any) =>
    same(req.headers["x-dia-token"] as string | undefined) || same(cookieToken(req.headers.cookie));

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const host = String(req.headers.host || "");
    const expectHost = [`127.0.0.1:${(server.address() as any)?.port || port}`, `localhost:${(server.address() as any)?.port || port}`];
    const log = (status: number) => console.log(JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: url.pathname, status }));

    if (!expectHost.includes(host)) {
      const portNow = (server.address() as any)?.port || port;
      if (host === `localhost:${portNow}`) { res.writeHead(302, { Location: `http://127.0.0.1:${portNow}/` }); res.end(); log(302); return; }
      res.writeHead(421); res.end("misdirected"); log(421); return;
    }
    const origin = req.headers.origin;
    if (origin && !expectHost.some((h) => origin === `http://${h}`)) { res.writeHead(403); res.end("bad origin"); log(403); return; }
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") { res.writeHead(403); res.end("cross-site"); log(403); return; }
    if (req.method !== "GET") { res.writeHead(405); res.end("method not allowed"); log(405); return; }

    // 首屏：?t=<token> → 种 HttpOnly cookie 并重定向，token 不留在页面 URL
    if (url.pathname === "/" && url.searchParams.get("t")) {
      if (!same(url.searchParams.get("t") || "")) { res.writeHead(401); res.end("unauthorized"); log(401); return; }
      res.writeHead(302, {
        "Set-Cookie": `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
        Location: "/",
      });
      res.end(); log(302); return;
    }

    if (!authorized(req)) { res.writeHead(401); res.end("unauthorized"); log(401); return; }
    const base = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
    };

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = renderHtml(graph.build(), { now: opts.now ?? new Date(), claims: claims.list({}).length, live: true, liveRev: revOf() });
        res.writeHead(200, { ...base, "Content-Type": "text/html; charset=utf-8" });
        res.end(html); log(200);
      } catch (e: any) {
        res.writeHead(503, { ...base, "Content-Type": "text/plain; charset=utf-8" });
        res.end(`E_LEDGER: ${e?.message || e}`); log(503);
      }
      return;
    }

    if (url.pathname === "/api/graph") {
      try {
        const { rev, graph: g } = payloadNow(opts.now);
        if (url.searchParams.get("rev") === rev || req.headers["if-none-match"] === rev) {
          res.writeHead(304, base); res.end(); log(304); return;
        }
        const payload = buildPayload(g, { now: opts.now ?? new Date(), claims: claims.list({}).length });
        res.writeHead(200, { ...base, "Content-Type": "application/json; charset=utf-8", ETag: rev });
        res.end(JSON.stringify({ schema: 1, rev, payload })); log(200);
      } catch (e: any) {
        res.writeHead(503, { ...base, "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "E_LEDGER", message: String(e?.message || e) } })); log(503);
      }
      return;
    }

    if (url.pathname === "/api/health") {
      res.writeHead(200, { ...base, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true })); log(200); return;
    }

    if (url.pathname === "/api/meta") {
      res.writeHead(200, { ...base, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ readonly: true, capabilities: ["eff-prio", "ready", "rank", "split"] })); log(200); return;
    }

    res.writeHead(404, { ...base, "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found"); log(404);
  });

  return { server, token, port };
}

export function startDiaServer(opts: ServerOptions = {}): Promise<{ server: any; url: string; token: string; close: () => Promise<void> }> {
  const { server, token } = createDiaServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as any;
      const url = `http://127.0.0.1:${addr.port}/?t=${encodeURIComponent(token)}`;
      resolve({ server, url, token, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
