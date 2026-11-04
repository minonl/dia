import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let task: any, team: any;

beforeAll(async () => {
  process.env.DIA_DATA_DIR = mkdtempSync(join(tmpdir(), "dia-team-"));
  task = await import("../src/task.ts");
  team = await import("../src/team.ts");
});

test("ACP 默认超时 10 分钟（180s 实测会掐断 builder）", () => {
  expect(team.DEFAULT_ACP_TIMEOUT).toBe(600_000);
});

describe("task ledger", () => {
  test("done requires judge and evidence", () => {
    const t = task.add("write code", { judge: "" });
    expect(() => task.status(t.id, "done", "x")).toThrow(/judge/);
  });

  test("add/list/status", () => {
    const t = task.add("with judge", { judge: "bun test" });
    expect(task.get(t.id).status).toBe("todo");
    expect(task.status(t.id, "doing").status).toBe("doing");
    expect(task.list().length).toBeGreaterThanOrEqual(2);
  });
});

describe("team state machine", () => {
  test("mock run reaches acceptance but gate 拒绝用它当判据证据", () => {
    const t = task.add("team task", { judge: "true" });
    team.runMock(t.id);
    expect(task.get(t.id).status).toBe("awaiting_acceptance");
    const g = team.gate(t.id);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("mock");
  });

  test("gate 现场重跑 judge：失败判 fail，成功放行", () => {
    const ws = mkdtempSync(join(tmpdir(), "dia-gate-ws-"));
    writeFileSync(join(ws, "a.txt"), "hi");
    const mk = (judge: string) => {
      const t = task.add("real gate " + judge, { judge });
      const dir = team.runDir(t.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.md"), "p");
      writeFileSync(join(dir, "diff.patch"), "d");
      writeFileSync(join(dir, "test.log"), "t");
      writeFileSync(join(dir, "verify.json"), JSON.stringify({ conclusion: "通过", evidence: ["cmd -> exit=0"] }));
      writeFileSync(join(dir, "redteam.json"), JSON.stringify({ findings: [] }));
      writeFileSync(join(dir, "packet.md"), "pk");
      writeFileSync(join(dir, "run.json"), JSON.stringify({ mock: false, workspace: ws, judge }));
      return t.id;
    };
    const bad = mk("test -f nope.txt");
    expect(team.gate(bad).ok).toBe(false);
    const good = mk("test -f a.txt");
    expect(team.gate(good).ok).toBe(true);
  });

  test("gate fails on non-passing verify", () => {
    const t = task.add("bad verify", { judge: "x" });
    team.runMock(t.id);
    writeFileSync(join(team.runDir(t.id), "verify.json"), JSON.stringify({ conclusion: "不通过", evidence: ["x"] }));
    expect(team.gate(t.id).ok).toBe(false);
  });

  test("gate rejects placeholder evidence", () => {
    const t = task.add("placeholder", { judge: "x" });
    team.runMock(t.id);
    writeFileSync(join(team.runDir(t.id), "verify.json"), JSON.stringify({ conclusion: "通过", evidence: ["(no evidence)"] }));
    expect(team.gate(t.id).ok).toBe(false);
  });

  test("gate accepts legitimate evidence containing 'no evidence of'（仍需真跑判据）", () => {
    const ws = mkdtempSync(join(tmpdir(), "dia-gate-ws2-"));
    writeFileSync(join(ws, "a.txt"), "hi");
    const t = task.add("legit evidence", { judge: "test -f a.txt" });
    const dir = team.runDir(t.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.md"), "p");
    writeFileSync(join(dir, "diff.patch"), "d");
    writeFileSync(join(dir, "test.log"), "t");
    writeFileSync(join(dir, "verify.json"), JSON.stringify({ conclusion: "通过", evidence: ["grep -r leak -> exit=1 | no evidence of leak"] }));
    writeFileSync(join(dir, "redteam.json"), JSON.stringify({ findings: [] }));
    writeFileSync(join(dir, "packet.md"), "pk");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ mock: false, workspace: ws, judge: "test -f a.txt" }));
    expect(team.gate(t.id).ok).toBe(true);
  });

  test("accept refuses when gate fails", () => {
    const t = task.add("fail gate", { judge: "x" });
    team.runMock(t.id);
    writeFileSync(join(team.runDir(t.id), "verify.json"), JSON.stringify({ conclusion: "不通过", evidence: ["x"] }));
    expect(() => team.accept(t.id)).toThrow(/E_GATE/);
  });

  test("reject requires reason", () => {
    const t = task.add("reject me", { judge: "x" });
    team.runMock(t.id);
    expect(() => team.reject(t.id, "")).toThrow(/reason/);
  });
});

describe("read-only isolation", () => {
  test("snapshot copies workspace and isolates writes", () => {
    const src = mkdtempSync(join(tmpdir(), "dia-ws-"));
    writeFileSync(join(src, "a.txt"), "orig");
    const snap = team.snapshotWorkspace(src, join(mkdtempSync(join(tmpdir(), "dia-snap-")), "snap"));
    writeFileSync(join(snap, "a.txt"), "changed");
    expect(require("node:fs").readFileSync(join(src, "a.txt"), "utf8")).toBe("orig");
  });

  test("verifier/redteam agents deny edit", () => {
    const fs = require("node:fs");
    for (const role of ["dabo-verifier", "dabo-redteam"]) {
      const text = fs.readFileSync(join(process.cwd(), "team", "agents", role + ".md"), "utf8");
      expect(text).toContain("action: edit");
      expect(text).toContain("effect: deny");
    }
  });
});

describe("snapshot hygiene", () => {
  test("excludes secrets and git config", () => {
    const src = mkdtempSync(join(tmpdir(), "dia-sec-"));
    mkdirSync(join(src, ".git"), { recursive: true });
    writeFileSync(join(src, ".env"), "TOKEN=x");
    writeFileSync(join(src, ".npmrc"), "//registry:_authToken=x");
    writeFileSync(join(src, ".git", "config"), "[remote] url=https://u:p@x");
    writeFileSync(join(src, "keep.txt"), "ok");
    const dest = join(mkdtempSync(join(tmpdir(), "dia-sec-out-")), "snap");
    team.snapshotWorkspace(src, dest);
    const fs = require("node:fs");
    expect(fs.existsSync(join(dest, ".env"))).toBe(false);
    expect(fs.existsSync(join(dest, ".npmrc"))).toBe(false);
    expect(fs.existsSync(join(dest, ".git", "config"))).toBe(false);
    expect(fs.existsSync(join(dest, "keep.txt"))).toBe(true);
  });

  test("cleanup removes snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "dia-clean-"));
    mkdirSync(join(dir, "verify-ws-0"), { recursive: true });
    mkdirSync(join(dir, "redteam-ws"), { recursive: true });
    team.cleanupSnapshots(dir);
    expect(require("node:fs").existsSync(join(dir, "verify-ws-0"))).toBe(false);
    expect(require("node:fs").existsSync(join(dir, "redteam-ws"))).toBe(false);
  });
});

describe("role output normalization", () => {
  test("verdict PASS maps to 通过", () => {
    const v = team.normalizeVerify({ verdict: "PASS", exit_code: 0 });
    expect(v.conclusion).toBe("通过");
    expect(v.evidence.length).toBeGreaterThan(0);
  });
  test("pass:true maps to 通过 with command evidence", () => {
    const v = team.normalizeVerify({ pass: true, command: "grep -qx ok f", exit_code: 0 });
    expect(v.conclusion).toBe("通过");
    expect(v.evidence[0]).toContain("grep");
  });
  test("verdict FAIL maps to 不通过", () => {
    expect(team.normalizeVerify({ verdict: "FAIL" }).conclusion).toBe("不通过");
  });
  test("unknown maps to 无法判定", () => {
    expect(team.normalizeVerify({ foo: 1 }).conclusion).toBe("无法判定");
  });
  test("no evidence stays empty (no placeholder)", () => {
    expect(team.normalizeVerify({ pass: true }).evidence).toEqual([]);
  });
  test("extracts first balanced object, ignores trailing prose", () => {
    expect(team.parseRoleJson('prose {"a":1} tail {"b":2}')).toEqual({ a: 1 });
  });
  test("parse error carries offset", () => {
    expect(() => team.parseRoleJson("{bad")).toThrow(/offset/);
  });
  test("fenced parse error offset is absolute", () => {
    expect(() => team.parseRoleJson('```json\n{"a":1,}\n```')).toThrow(/offset 8/);
  });
  test("redteam issues maps to findings", () => {
    expect(team.normalizeRedteam({ issues: [{ a: 1 }] }).findings.length).toBe(1);
  });
});

describe("role repair loop", () => {
  test("repairs malformed JSON once", async () => {
    const r = await team.parseRoleJsonWithRepair("{bad", async () => '{"conclusion":"通过","evidence":["x"]}');
    expect(r.repaired).toBe(true);
    expect(r.value.conclusion).toBe("通过");
  });
  test("no repair when valid", async () => {
    const r = await team.parseRoleJsonWithRepair('{"conclusion":"通过","evidence":["x"]}', async () => { throw new Error("should not retry"); });
    expect(r.repaired).toBe(false);
  });
  test("fails after one repair", async () => {
    await expect(team.parseRoleJsonWithRepair("{bad", async () => "still bad")).rejects.toThrow();
  });
});


describe("accept 接 CI 门禁", () => {
  test("prStatus：全部 pass 才 ok；有 fail 列出检查名", () => {
    const bin = mkdtempSync(join(tmpdir(), "dia-ghbin2-"));
    const gh = join(bin, "gh");
    writeFileSync(gh, `#!/bin/sh
if [ "$1 $2" = "pr checks" ]; then
  if [ "$FAKE_CHECKS" = "fail" ]; then echo '[{"name":"test (ubuntu-latest)","bucket":"fail"}]'; else echo '[{"name":"test (ubuntu-latest)","bucket":"pass"}]'; fi
else
  echo merged
fi
`);
    chmodSync(gh, 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      process.env.FAKE_CHECKS = "pass";
      expect(team.prStatus("1", "o/r").ok).toBe(true);
      process.env.FAKE_CHECKS = "fail";
      const bad = team.prStatus("1", "o/r");
      expect(bad.ok).toBe(false);
      expect(bad.failed[0]).toContain("ubuntu");
    } finally { process.env.PATH = old; delete process.env.FAKE_CHECKS; }
  });
});
