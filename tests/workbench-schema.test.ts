import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[]) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env as Record<string, string>, DIA_ROOT: root },
});
const json = (s: string) => JSON.parse(s);

const writeTracks = (rows: object[]) => {
  mkdirSync(join(root, "workbench"), { recursive: true });
  writeFileSync(join(root, "workbench", "tracks.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-wb-")); });
afterEach(() => { delete process.env.DIA_ROOT; });

describe("dia wb（M0 契约）", () => {
  test("空数据根：--json 返回 schema_v:1 且不崩", () => {
    const r = run(["wb", "--json"]);
    expect(r.status).toBe(0);
    const s = json(r.stdout);
    expect(s.schema_v).toBe(1);
    expect(Array.isArray(s.tracks)).toBe(true);
    expect(s.tracks.length).toBe(0);
    expect(typeof s.sources).toBe("object");
    expect(s.worktrees.schema_v).toBe(1);
  });

  test("同一个 --now 两次输出字节一致（去 duration_ms）", () => {
    writeTracks([
      { ts: "2026-01-01T00:00:00.000Z", event: "open", id: "tr-aaaa1111", title: "示例线", goal: "g", repo: ["fed/lyzr/hummus"], prio: "P1", next: "写测试" },
    ]);
    const now = "2026-01-02T03:04:05.000Z";
    const a = json(run(["wb", "--json", "--now", now]).stdout);
    const b = json(run(["wb", "--json", "--now", now]).stdout);
    delete a.duration_ms; delete b.duration_ms;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("非法 --now 退出码 2", () => {
    const r = run(["wb", "--json", "--now", "not-a-date"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_WB");
  });

  test("折叠 tracks.jsonl：open/bind/stage/next", () => {
    writeTracks([
      { ts: "2026-01-01T00:00:00.000Z", event: "open", id: "tr-bbbb2222", title: "灰度开通", goal: "收口", repo: ["fed/lyzr/hummus"], prio: "P1", next: "补单测" },
      { ts: "2026-01-01T01:00:00.000Z", event: "bind", id: "tr-bbbb2222", session: "ses_x", role: "lead", host: "opencode" },
      { ts: "2026-01-01T02:00:00.000Z", event: "stage", id: "tr-bbbb2222", status: "blocked", reason: "等 CI" },
      { ts: "2026-01-01T03:00:00.000Z", event: "next", id: "tr-bbbb2222", next: "改派 lead", waiting_on: { kind: "human", ref: "min" } },
    ]);
    const s = json(run(["wb", "--json"]).stdout);
    expect(s.tracks.length).toBe(1);
    const t = s.tracks[0];
    expect(t.id).toBe("tr-bbbb2222");
    expect(t.status).toBe("blocked");
    expect(t.next).toBe("改派 lead");
    expect(t.waiting_on.kind).toBe("human");
    expect(t.sessions[0].session_id).toBe("ses_x");
    expect(t.sessions[0].role).toBe("lead");
  });

  test("refresh 落盘，之后 wb 读快照（as_of 不变）", () => {
    const now = "2026-02-02T00:00:00.000Z";
    const r = run(["wb", "refresh", "--json", "--now", now]);
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "workbench", "derived", "snapshot.json"))).toBe(true);
    const disk = json(readFileSync(join(root, "workbench", "derived", "snapshot.json"), "utf8"));
    expect(disk.as_of).toBe(now);
    const read = json(run(["wb", "--json"]).stdout);
    expect(read.as_of).toBe(now);
  });

  test("migrate --dry-run 不写盘", () => {
    const r = run(["wb", "migrate", "--dry-run", "--json"]);
    expect(r.status).toBe(0);
    const m = json(r.stdout);
    expect(m.dry_run).toBe(true);
    expect(existsSync(join(root, "workbench", "derived"))).toBe(false);
    expect(existsSync(join(root, "workbench", "config.json"))).toBe(false);
  });

  test("gc：白名单外一律可清，durable 保留", () => {
    mkdirSync(join(root, "workbench", "derived"), { recursive: true });
    writeTracks([{ ts: "2026-01-01T00:00:00.000Z", event: "open", id: "tr-keep0001", title: "保留", repo: ["fed/lyzr/hummus"], prio: "P2", next: "x" }]);
    writeFileSync(join(root, "workbench", "stray.json"), "{}");
    writeFileSync(join(root, "workbench", "derived", "snapshot.json"), "{}");

    const dry = json(run(["wb", "gc", "--json"]).stdout);
    expect(dry.dry_run).toBe(true);
    expect(dry.removed.some((x: any) => x.path === "stray.json" && x.reason === "not-whitelisted")).toBe(true);
    expect(existsSync(join(root, "workbench", "stray.json"))).toBe(true);

    const applied = json(run(["wb", "gc", "--apply", "--json"]).stdout);
    expect(applied.dry_run).toBe(false);
    expect(existsSync(join(root, "workbench", "stray.json"))).toBe(false);
    expect(existsSync(join(root, "workbench", "tracks.jsonl"))).toBe(true);
  });

  test("符号链接不跟随、不删除", () => {
    mkdirSync(join(root, "workbench"), { recursive: true });
    const target = join(root, "outside.txt");
    writeFileSync(target, "keep me");
    symlinkSync(target, join(root, "workbench", "link.txt"));
    const r = json(run(["wb", "gc", "--apply", "--json"]).stdout);
    expect(r.skipped.some((x: any) => x.path === "link.txt")).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe("白名单写入校验", () => {
  test("白名单外拒绝写", async () => {
    process.env.DIA_ROOT = root;
    const { writeAtomic } = await import("../src/workbench/store.ts");
    expect(() => writeAtomic(join(root, "workbench", "stray.json"), "{}")).toThrow(/E_WB_WHITELIST/);
  });

  test("tracks 超行数时 compact（有损）而不是无限增长", async () => {
    process.env.DIA_ROOT = root;
    mkdirSync(join(root, "workbench"), { recursive: true });
    writeFileSync(join(root, "workbench", "config.json"), JSON.stringify({
      schema_v: 1,
      durable: [
        { path: "tracks.jsonl", why: "t", max_bytes: 8 * 1024 * 1024, max_lines: 10, on_overflow: "compact" },
        { path: "queue.jsonl", why: "q", max_bytes: 1024 * 1024, max_lines: 100, on_overflow: "fail" },
        { path: "config.json", why: "c", max_bytes: 65536, max_lines: 100, on_overflow: "fail" },
      ],
      ephemeral: [],
      quota: { root_max_bytes: 100 * 1024 * 1024, warn_ratio: 0.8 },
    }));
    const { appendTrack, foldTracks } = await import("../src/workbench/store.ts");
    const ts = new Date().toISOString();
    appendTrack({ ts, event: "open", id: "tr-compact1", title: "压缩测试", next: "x" });
    for (let i = 0; i < 14; i++) appendTrack({ ts, event: "bind", id: "tr-compact1", session: "ses_a", role: "lead", host: "opencode" });
    const lines = readFileSync(join(root, "workbench", "tracks.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(lines).toBeLessThanOrEqual(10);
    const { tracks } = foldTracks();
    expect(tracks.length).toBe(1);
    expect(tracks[0].sessions.length).toBe(1);
  });
});
