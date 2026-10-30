import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { ingest, parseDsh } from "../src/ingest.ts";
import { redact } from "../src/redact.ts";
import { openDb } from "../src/sqlite.ts";

describe("redact", () => {
  test("redacts tokens, emails, assignments", () => {
    const r = redact("key ghp_abcdefghijklmnopqrstuvwxyz0123 mail a.b@example.com TOKEN=supersecret");
    expect(r.text).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(r.text).toContain("[REDACTED:EMAIL]");
    expect(r.text).toContain("TOKEN=[REDACTED:ASSIGNMENT]");
    expect(r.text).not.toContain("a.b@example.com");
  });
  test("keeps normal Chinese text", () => {
    const s = "今天修复了知识库索引覆盖问题";
    expect(redact(s).text).toBe(s);
  });
});

let root: string, out: string, cache: string;

function writeDsh(session: string, withFailure: boolean) {
  const dir = join(root, session);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", id: session, createdAt: Date.parse("2026-10-01T10:00:00Z"), cwd: "/tmp/work" },
    { type: "user/message", seq: 1, time: Date.parse("2026-10-01T10:00:01Z"), data: { content: "帮我修复索引 bug" } },
    { type: "tool/call", seq: 2, time: Date.parse("2026-10-01T10:00:02Z"), data: { name: "bash", callId: "1" } },
    { type: "tool/result", seq: 3, time: Date.parse("2026-10-01T10:00:03Z"), data: { message: { ok: !withFailure } } },
    { type: "tool/call", seq: 4, time: Date.parse("2026-10-01T10:00:04Z"), data: { name: "bash", callId: "2" } },
    { type: "tool/result", seq: 5, time: Date.parse("2026-10-01T10:00:05Z"), data: { message: {} } },
    { type: "tool/call", seq: 6, time: Date.parse("2026-10-01T10:00:06Z"), data: { name: "read", callId: "3" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(lines)));
  return join(dir, "session.v4.jsonl.zstd");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dia-ingest-"));
  out = mkdtempSync(join(tmpdir(), "dia-out-"));
  cache = mkdtempSync(join(tmpdir(), "dia-cache-"));
});

afterAll(() => { for (const d of [root, out, cache]) rmSync(d, { recursive: true, force: true }); });

describe("dsh ingest", () => {
  test("parses session and aggregates tools", () => {
    const f = writeDsh("s1", true);
    const ep = parseDsh(f, "dabo")!;
    expect(ep.turns).toBe(1);
    expect(ep.tools.find((t) => t.name === "bash")!.count).toBe(2);
    expect(ep.tools.find((t) => t.name === "bash")!.ok).toBe(1);
    expect(ep.summary).toContain("修复");
    expect(ep.agent).toBeNull();
  });

  test("is incremental and read-only", async () => {
    const f = writeDsh("s2", false);
    const before = statSync(f).mtimeMs;
    const o = mkdtempSync(join(tmpdir(), "dia-out2-"));
    const c = mkdtempSync(join(tmpdir(), "dia-cache2-"));
    const r1 = await ingest({ sources: ["dsh"], sessionsRoot: root, outDir: o, cacheDir: c, full: true });
    expect(r1.written).toBe(2);
    const r2 = await ingest({ sources: ["dsh"], sessionsRoot: root, outDir: o, cacheDir: c });
    expect(r2.written).toBe(0);
    expect(statSync(f).mtimeMs).toBe(before);
    rmSync(o, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  });

  test("candidate requires failure or keyword", async () => {
    const o = mkdtempSync(join(tmpdir(), "dia-out3-"));
    const c = mkdtempSync(join(tmpdir(), "dia-cache3-"));
    const r = await ingest({ sources: ["dsh"], sessionsRoot: root, outDir: o, cacheDir: c, full: true });
    expect(r.candidates).toBeGreaterThanOrEqual(1);
    rmSync(o, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  });
});

describe("opencode ingest", () => {
  test("reads sessions/messages/parts read-only", async () => {
    const dbPath = join(root, "opencode.db");
    const db = await openDb(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, project_id TEXT, path TEXT, workspace_id TEXT)");
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)");
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)", ["s1", null, "修复登录问题", "/tmp/w", "build", 1, 2, "proj-1", "src/a.ts", "ws-1"]);
    db.run("INSERT INTO message VALUES (?,?,?)", ["m1", "s1", JSON.stringify({ role: "user" })]);
    db.run("INSERT INTO part VALUES (?,?,?,?)", ["p1", "m1", "s1", JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed" } })]);
    db.run("INSERT INTO part VALUES (?,?,?,?)", ["p2", "m1", "s1", JSON.stringify({ type: "tool", tool: "bash", state: { status: "error" } })]);
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)", ["s2", null, "另一个项目", "/tmp/w2", "build", 3, 4, "proj-2", "src/b.ts", null]);
    db.close();

    const ocOut = mkdtempSync(join(tmpdir(), "dia-oc-"));
    const ocCache = mkdtempSync(join(tmpdir(), "dia-occ-"));
    const r = await ingest({ sources: ["opencode"], opencodeDb: dbPath, outDir: ocOut, cacheDir: ocCache, full: true, domain: "dabo" });
    expect(r.written).toBe(2);
    const ep = r.episodes[0];
    expect(ep.turns).toBe(1);
    expect(ep.tools.find((t) => t.name === "bash")!.count).toBe(2);
    expect(ep.tools.find((t) => t.name === "bash")!.ok).toBe(1);
    expect(ep.agent).toBe("build");
    expect(ep.workspace_id).toBe("ws-1");
    expect(ep.project).toHaveLength(12);
    expect(ep.directory_hash).toHaveLength(12);
    expect(ep.path_hash).toHaveLength(12);
    // 默认跨 project 全采
    expect(r.written).toBe(2);

    // --project 过滤只采一个
    const ocOut2 = mkdtempSync(join(tmpdir(), "dia-oc2-"));
    const ocCache2 = mkdtempSync(join(tmpdir(), "dia-occ2-"));
    const r2 = await ingest({ sources: ["opencode"], opencodeDb: dbPath, outDir: ocOut2, cacheDir: ocCache2, full: true, domain: "dabo", project: "proj-1" });
    expect(r2.written).toBe(1);
    expect(r2.episodes[0].project).toHaveLength(12);

    rmSync(ocOut, { recursive: true, force: true });
    rmSync(ocCache, { recursive: true, force: true });
    rmSync(ocOut2, { recursive: true, force: true });
    rmSync(ocCache2, { recursive: true, force: true });
  });
});
