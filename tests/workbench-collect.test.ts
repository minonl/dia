// dia workbench —— M1 采集器判据（fixture + --now 注入 + DIA_ROOT 隔离）
//
// 设计：docs/design/workbench.md §11 M1
//   ① fixture v2 表出正确 session；② 宿主库 sha256 前后一致；
//   ③ refresh --depth fast 在 fixture 上快（这里只判采集本身不跑全量 status）；
//   ④ 只有 legacy 表时 sources.opencode:"unsupported" + 明确告警。
// 约定：所有测试用临时 DIA_ROOT，afterEach 还原 env（踩过 DIA_ROOT 泄漏导致别处假失败）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { collectAll } from "../src/workbench/collect/index.ts";
import { collectOpencode } from "../src/workbench/collect/opencode.ts";
import { collectWorktrees, slugFromRemote } from "../src/workbench/collect/worktrees.ts";
import type { Track } from "../src/workbench/schema.ts";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024, // 全量 snapshot --json 已超 1MiB（1140+ 会话）
  env: { ...process.env as Record<string, string>, DIA_ROOT: diaRoot, ...env },
});

let diaRoot: string;
let work: string;
const origRoot = process.env.DIA_ROOT;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>,
  }).trim();
}

function createV2Db(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_suspended INTEGER
    );
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT);
  `);
  const ins = db.prepare(
    "INSERT INTO session_v2(id,parent_id,title,directory,model,cost,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write," +
      "time_created,time_updated,time_archived,time_suspended) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // 5 分钟前有活动 → alive
  ins.run(
    "ses_alive001", null, "灰度开通收口", "/tmp/demo", "example/deepseek-v4.1-flash", 0.5,
    1200, 34, 900, 0, NOW.getTime() - 2 * HOUR, NOW.getTime() - 5 * MIN, null, null,
  );
  // 2 小时前活动 → suspect（靠心跳可路由）
  ins.run(
    "ses_suspect003", null, "等 CI", "/tmp/demo", "example/deepseek-v4.1-flash", 0,
    10, 2, 0, 0, NOW.getTime() - 3 * HOUR, NOW.getTime() - 2 * HOUR, null, null,
  );
  // 48 小时前活动 → dead（仍 resumable）
  ins.run(
    "ses_dead002", null, "旧会话", "/tmp/demo", "example/glm-4.6", 0,
    7, 1, 0, 0, NOW.getTime() - 60 * HOUR, NOW.getTime() - 48 * HOUR, null, null,
  );
  // 历史 suspended（早于 time_updated）≠ 当前挂起 → 仍 alive（2026-11-18 真机回归）
  ins.run(
    "ses_resumed004", null, "恢复过的会话", "/tmp/demo", "example/deepseek-v4.1-flash", 0,
    100, 10, 0, 0, NOW.getTime() - 2 * HOUR, NOW.getTime() - 3 * MIN, null, NOW.getTime() - 6 * MIN,
  );
  const msg = db.prepare("INSERT INTO session_message(id,session_id,type,data) VALUES(?,?,?,?)");
  for (let i = 0; i < 3; i++) msg.run(`m-u${i}`, "ses_alive001", "user", `{"i":${i}}`);
  for (let i = 0; i < 5; i++) msg.run(`m-a${i}`, "ses_alive001", "assistant", `{"i":${i}}`);
  for (let i = 0; i < 4; i++) msg.run(`m-i${i}`, "ses_alive001", "idle", `{"i":${i}}`);
  db.close();
}

function createLegacyDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER);");
  db.prepare("INSERT INTO session(id,directory,time_updated) VALUES(?,?,?)").run("ses_legacy1", "/tmp/old", NOW.getTime());
  db.close();
}

function writeClaim(path: string, opts: { id: string; path: string; scope: string; holder: string; at: string }) {
  mkdirSync(join(diaRoot, "collab"), { recursive: true });
  const row = {
    ts: opts.at,
    event: "claim",
    id: opts.id,
    path: opts.path,
    scope: opts.scope,
    holder: opts.holder,
    created_at: opts.at,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  writeFileSync(path, JSON.stringify(row) + "\n");
}

beforeEach(() => {
  diaRoot = mkdtempSync(join(tmpdir(), "dia-wb-collect-"));
  work = mkdtempSync(join(tmpdir(), "dia-wb-git-"));
  process.env.DIA_ROOT = diaRoot;
});

afterEach(() => {
  if (origRoot === undefined) delete process.env.DIA_ROOT;
  else process.env.DIA_ROOT = origRoot;
  delete process.env.DIA_WB_OPENCODE_DB;
  rmSync(diaRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("opencode 采集（v2 only）", () => {
  test("v2 fixture：会话/ token / turns / liveness 正确，且不写宿主库", () => {
    const dbPath = join(work, "opencode.db");
    createV2Db(dbPath);
    const before = sha256(dbPath);

    const r = collectOpencode({ dbPath, now: NOW });
    expect(r.source.status).toBe("ok");
    expect(r.source.schema).toBe("v2");
    expect(r.sessions.length).toBe(4);

    const byId = new Map(r.sessions.map((s) => [s.session_id, s]));
    const alive = byId.get("ses_alive001")!;
    expect(alive.liveness).toBe("alive");
    expect(alive.delivery_ready).toBe(true);
    expect(alive.route_eligible).toBe(true);
    expect(alive.turns).toBe(3); // 只数 type='user'，idle 不计
    expect(alive.tokens).toEqual({ input: 1200, output: 34, cache_read: 900, cache_write: 0 });
    expect(alive.cost_usd).toBe(0.5);
    expect(alive.priced).toBe(true);
    expect(alive.title).toBe("灰度开通收口");
    expect(alive.models).toEqual(["example/deepseek-v4.1-flash"]);
    expect(alive.host).toBe("opencode");

    const suspect = byId.get("ses_suspect003")!;
    expect(suspect.liveness).toBe("suspect");
    expect(suspect.route_eligible).toBe(false); // 无 claim / 无心跳

    const dead = byId.get("ses_dead002")!;
    expect(dead.liveness).toBe("dead");
    expect(dead.resumable).toBe(true);
    expect(dead.delivery_ready).toBe(false);
    expect(dead.cost_usd).toBe(null); // 0 ≠ 免费
    expect(dead.priced).toBe(false);

    // time_suspended 是历史事件：早于 time_updated 时不应判死
    const resumed = byId.get("ses_resumed004")!;
    expect(resumed.liveness).toBe("alive");
    expect(resumed.delivery_ready).toBe(true);
    expect(resumed.route_eligible).toBe(true);

    expect(sha256(dbPath)).toBe(before); // ② 宿主库字节不变
  });

  test("只有 legacy session 表 → unsupported + 明确告警", () => {
    const dbPath = join(work, "legacy.db");
    createLegacyDb(dbPath);

    const r = collectOpencode({ dbPath, now: NOW });
    expect(r.sessions.length).toBe(0);
    expect(r.source.status).toBe("unsupported");
    expect(r.source.schema).toBe("legacy");
    expect(r.source.detail).toContain("dia wb migrate");

    const all = collectAll({ opencodeDbPath: dbPath, now: NOW, depth: "fast" });
    expect(all.sources.opencode.status).toBe("unsupported");
    expect(all.alerts.some((a) => a.kind === "opencode-unsupported")).toBe(true);
  });

  test("db 不存在 → unavailable（不抛）", () => {
    const r = collectOpencode({ dbPath: join(work, "nope.db"), now: NOW });
    expect(r.source.status).toBe("unavailable");
    expect(r.sessions).toEqual([]);
  });
});

describe("worktree 采集（多仓 / dirty 门控）", () => {
  function makeRepo() {
    const repo = join(work, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@example.com"], repo);
    git(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "init"], repo);
    git(["remote", "add", "origin", "git@git.example.com:org/group/demo.git"], repo);
    const wt = join(work, "wt-feat");
    git(["worktree", "add", "-q", wt, "-b", "feat/demo"], repo);
    return { repo, wt };
  }

  test("slug 解析完整 group 路径", () => {
    expect(slugFromRemote("git@git.example.com:org/group/project-a.git")).toBe("org/group/project-a");
    expect(slugFromRemote("https://git.example.com/org/group/project-a.git")).toBe("org/group/project-a");
    expect(slugFromRemote("ssh://git@host:2222/org/group/project-a")).toBe("org/group/project-a");
  });

  test("claimed 才跑 dirty；未认领标 orphan/not_checked", () => {
    const { repo, wt } = makeRepo();
    // claim 用旧的两段式 scope（group/demo）→ 必须能匹配 org/group/demo
    writeClaim(join(diaRoot, "collab", "claims.jsonl"), {
      id: "c-1", path: "a.txt", scope: "group/demo", holder: "ses_alive001", at: iso(10 * MIN),
    });

    const fast = collectWorktrees({ repoPaths: [repo], depth: "fast", now: NOW, timeoutMs: 4000 });
    expect(fast.worktrees.repos.length).toBe(1);
    const view = fast.worktrees.repos[0];
    expect(view.repo).toBe("org/group/demo");
    expect(view.worktrees.length).toBe(2);

    const main = view.worktrees.find((w) => w.path === realpathSync(repo))!;
    expect(main.flags).toContain("claimed");
    expect(main.dirty_state).toBe("checked");
    expect(main.dirty).toBe(0);
    expect(main.claim?.holder).toBe("ses_alive001");

    const linked = view.worktrees.find((w) => w.path === realpathSync(wt))!;
    expect(linked.flags).toContain("orphan");
    expect(linked.flags).toContain("not_checked");
    expect(linked.dirty).toBe(null); // 不写 0 假装干净
    expect(linked.dirty_state).toBe("not_checked");
    expect(linked.branch).toBe("feat/demo");
    expect(linked.head.length).toBe(7);
    expect(linked.merged_to_main).toBe(false); // 未检查 → 不声称已合并

    // 主 checkout 有未提交 → main-dirty
    writeFileSync(join(repo, "a.txt"), "a changed\n");
    const dirty = collectWorktrees({ repoPaths: [repo], depth: "fast", now: NOW, timeoutMs: 4000 });
    const mainDirty = dirty.worktrees.repos[0].worktrees.find((w) => w.path === realpathSync(repo))!;
    expect(mainDirty.dirty).toBe(1);
    expect(mainDirty.flags).toContain("main-dirty");

    // depth=full：未认领也检查，且 behind_main 生效
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "second"], repo);
    const full = collectWorktrees({ repoPaths: [repo], depth: "full", now: NOW, timeoutMs: 4000 });
    const linkedFull = full.worktrees.repos[0].worktrees.find((w) => w.path === realpathSync(wt))!;
    expect(linkedFull.dirty_state).toBe("checked");
    expect(linkedFull.flags).not.toContain("not_checked");
    expect(linkedFull.behind_main).toBe(1);
    expect(linkedFull.flags).toContain("behind");
  }, 30_000);
});

describe("collectAll 聚合", () => {
  test("sessions/worktrees/sources/alerts + 心跳与 track 回填", () => {
    const dbPath = join(work, "opencode.db");
    createV2Db(dbPath);
    const { repo } = (() => {
      const r = join(work, "repo");
      mkdirSync(r, { recursive: true });
      git(["init", "-q", "-b", "main"], r);
      git(["config", "user.email", "t@example.com"], r);
      git(["config", "user.name", "t"], r);
      writeFileSync(join(r, "a.txt"), "a\n");
      git(["add", "."], r);
      git(["commit", "-q", "-m", "init"], r);
      git(["remote", "add", "origin", "https://git.example.com/org/group/demo.git"], r);
      return { repo: r };
    })();
    writeClaim(join(diaRoot, "collab", "claims.jsonl"), {
      id: "c-9", path: "a.txt", scope: "org/group/demo", holder: "ses_alive001", at: iso(10 * MIN),
    });
    mkdirSync(join(diaRoot, "workbench"), { recursive: true });
    writeFileSync(
      join(diaRoot, "workbench", "beats.jsonl"),
      JSON.stringify({ ts: iso(5 * MIN), session: "ses_suspect003", host: "opencode" }) + "\n",
    );

    const tracks: Track[] = [{
      id: "tr-demo0001", title: "示例线", goal: "g", status: "active", stage: "dev", next: "x",
      repo: ["org/group/demo"], prio: "P1", refs: [], tasks: [],
      sessions: [{ session_id: "ses_alive001", role: "lead", host: "opencode", bound_at: iso(3 * HOUR) }],
      created_at: iso(3 * HOUR), updated_at: iso(3 * HOUR),
    }];

    const c = collectAll({ opencodeDbPath: dbPath, now: NOW, depth: "fast", tracks, repoPaths: [repo] });
    expect(c.sessions.length).toBe(4);
    expect(c.sources.opencode.status).toBe("ok");
    expect(typeof c.sources.opencode.duration_ms).toBe("number");
    expect(typeof c.sources.worktrees.duration_ms).toBe("number");
    expect(Array.isArray(c.alerts)).toBe(true);

    const byId = new Map(c.sessions.map((s) => [s.session_id, s]));
    expect(byId.get("ses_alive001")!.tracks).toEqual(["tr-demo0001"]);
    // beats 回填最后心跳
    const suspect = byId.get("ses_suspect003")!;
    expect(suspect.last_heartbeat).toBe(iso(5 * MIN));
    // suspect + 15min 内心跳 → 可路由（§5.1）
    expect(suspect.liveness).toBe("suspect");
    expect(suspect.route_eligible).toBe(true);
    expect(suspect.liveness_evidence.some((e) => e.source === "beat")).toBe(true);

    expect(c.worktrees.repos[0].repo).toBe("org/group/demo");
    expect(c.worktrees.repos[0].worktrees.some((w) => w.flags.includes("claimed"))).toBe(true);

    // DIA_ROOT 隔离：宿主库与 claim 都在临时目录，未污染 ~/.dia
    expect(existsSync(join(diaRoot, "collab", "claims.jsonl"))).toBe(true);
  }, 30_000);

  test("wb refresh --json --summary：只出计数，不出 sessions 明细", () => {
    const dbPath = join(work, "opencode.db");
    createV2Db(dbPath);
    const r = run(["wb", "refresh", "--json", "--summary", "--now", NOW.toISOString()], { DIA_WB_OPENCODE_DB: dbPath });
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.counts.sessions.total).toBe(4);
    expect(s.counts.sessions.alive).toBe(2);
    expect(s.counts.sessions.dead).toBe(1);
    expect(s.counts.sessions.dead_resumable).toBe(1);
    expect(s.sessions).toBeUndefined();
    expect(s.worktrees).toBeUndefined();
    expect(r.stdout.length).toBeLessThan(200_000);
    // 落盘的仍是全量快照（summary 只影响输出，不影响数据）
    const disk = JSON.parse(readFileSync(join(diaRoot, "workbench", "derived", "snapshot.json"), "utf8"));
    expect(disk.sessions.length).toBe(4);

    // 全量 --json 走管道也不能被截断（>128KB 时曾踩到 process.exit 截断）
    const full = run(["wb", "--json"]);
    expect(full.status).toBe(0);
    const parsed = JSON.parse(full.stdout);
    expect(parsed.sessions.length).toBe(4);
    expect(parsed.as_of).toBe(NOW.toISOString());
  }, 30_000);
});
