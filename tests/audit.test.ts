import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let audit: any, freeze: any, run: any, resume: any, rt: any;

beforeAll(async () => {
  process.env.DIA_DATA_DIR = mkdtempSync(join(tmpdir(), "dia-audit-data-"));
  process.env.DIA_STATE_DIR = mkdtempSync(join(tmpdir(), "dia-audit-state-"));
  audit = await import("../src/audit.ts");
  freeze = await import("../src/freeze.ts");
  run = await import("../src/run.ts");
  resume = await import("../src/resume.ts");
  rt = await import("../src/runtime.ts");
});

describe("audit", () => {
  test("append + verify reconciliation", () => {
    for (let i = 0; i < 3; i++) audit.append({ session: "s-ok", tool: "bash", decision: "allow" });
    expect(audit.verify("s-ok", 3).ok).toBe(true);
    const bad = audit.verify("s-ok", 4);
    expect(bad.ok).toBe(false);
    expect(bad.gap).toBe(1);
  });

  test("score accumulates deny/waive", () => {
    audit.append({ session: "s-score", tool: "bash", decision: "deny" });
    audit.append({ session: "s-score", tool: "send", decision: "waive", risk: 4 });
    const r = audit.score("s-score");
    expect(r.score).toBe(6);
    expect(r.level).toBe("warn");
  });

  test("redline auto-freezes", () => {
    audit.append({ session: "s-red", tool: "bash", decision: "allow", redline: true });
    expect(freeze.status().frozen).toBe(true);
    expect(freeze.snapshot()?.last_episode).toBeUndefined();
    freeze.thaw({ reason: "test reset", human: true });
  });
});

describe("dia run", () => {
  test("wrapped run writes audit and reconciles", () => {
    const r = run.runWrapped(["echo", "hi"], { session: "s-run", stdio: "pipe" });
    expect(r.exit).toBe(0);
    expect(r.audit_written).toBe(true);
    expect(audit.verify("s-run", rt.countCalls("s-run")).ok).toBe(true);
  });

  test("records non-zero exit", () => {
    const r = run.runWrapped(["sh", "-c", "exit 7"], { session: "s-run2", stdio: "pipe" });
    expect(r.exit).toBe(7);
  });

  test("frozen system refuses execution", () => {
    freeze.freeze({ reason: "test freeze", by: "auto" });
    const r = run.runWrapped(["echo", "nope"], { session: "s-run3", stdio: "pipe" });
    expect(r.exit).toBe(42);
    expect(r.audit_written).toBe(false);
    freeze.thaw({ reason: "ok", human: true });
  });

  test("never stores raw args", () => {
    run.runWrapped(["echo", "ghp_abcdefghijklmnopqrstuvwxyz0123"], { session: "s-run4", stdio: "pipe" });
    const fs = require("node:fs");
    expect(fs.readFileSync(audit.auditFile(), "utf8")).not.toContain("ghp_");
  });

  test("detects missing audit row", () => {
    run.runWrapped(["echo", "a"], { session: "s-run5", stdio: "pipe" });
    run.runWrapped(["echo", "b"], { session: "s-run5", stdio: "pipe" });
    const fs = require("node:fs");
    const logBackup = fs.readFileSync(audit.auditFile(), "utf8");
    const headBackup = fs.existsSync(audit.headFile()) ? fs.readFileSync(audit.headFile(), "utf8") : null;
    try {
      const lines = logBackup.split("\n").filter(Boolean);
      const idx = lines.findIndex((l: string) => l.includes('"s-run5"'));
      lines.splice(idx, 1);
      fs.writeFileSync(audit.auditFile(), lines.join("\n") + "\n");
      expect(audit.verify("s-run5", rt.countCalls("s-run5")).ok).toBe(false);
    } finally {
      // 删行会永久破坏链；后续用例需要健康日志，这里恢复现场
      fs.writeFileSync(audit.auditFile(), logBackup);
      if (headBackup === null) fs.rmSync(audit.headFile(), { force: true });
      else fs.writeFileSync(audit.headFile(), headBackup);
    }
  });
});

describe("H3 resume", () => {
  test("freeze -> thaw -> resume keeps completed steps", () => {
    run.runWrapped(["sh", "-c", "exit 0"], { session: "s-h3", stdio: "pipe" });
    run.runWrapped(["sh", "-c", "exit 4"], { session: "s-h3", stdio: "pipe" });
    run.runWrapped(["sh", "-c", "exit 0"], { session: "s-h3", stdio: "pipe" });
    freeze.freeze({ reason: "test", by: "auto", session: "s-h3" });
    expect(() => resume.resumeCard("s-h3")).toThrow();
    freeze.thaw({ reason: "reviewed", human: true });
    const card = resume.resumeCard("s-h3");
    expect(card.completed_runs).toBe(3);
    expect(card.last_exit).toBe(0);
    expect(card.last_failure?.exit).toBe(4);
    expect(card.audit_ok).toBe(true);
  });

  test("resume reports audit gap", () => {
    const fs = require("node:fs");
    const logBackup = fs.readFileSync(audit.auditFile(), "utf8");
    const headBackup = fs.existsSync(audit.headFile()) ? fs.readFileSync(audit.headFile(), "utf8") : null;
    try {
      const lines = logBackup.split("\n").filter(Boolean);
      const idx = lines.findIndex((l: string) => l.includes('"s-h3"'));
      lines.splice(idx, 1);
      fs.writeFileSync(audit.auditFile(), lines.join("\n") + "\n");
      const card = resume.resumeCard("s-h3");
      expect(card.audit_ok).toBe(false);
      expect(card.audit_gap).toBe(1);
    } finally {
      fs.writeFileSync(audit.auditFile(), logBackup);
      if (headBackup === null) fs.rmSync(audit.headFile(), { force: true });
      else fs.writeFileSync(audit.headFile(), headBackup);
    }
  });
});

describe("hash chain 回归（redteam 发现）", () => {
  test("坏行（null）判定为链断点，不抛 TypeError", () => {
    const fs = require("node:fs");
    const backup = fs.readFileSync(audit.auditFile(), "utf8");
    const headBackup = fs.existsSync(audit.headFile()) ? fs.readFileSync(audit.headFile(), "utf8") : null;
    try {
      fs.appendFileSync(audit.auditFile(), "null\n");
      const r = audit.verifyChain();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("malformed");
      expect(() => audit.score("s-x")).not.toThrow();
    } finally {
      fs.writeFileSync(audit.auditFile(), backup);
      if (headBackup === null) fs.rmSync(audit.headFile(), { force: true });
      else fs.writeFileSync(audit.headFile(), headBackup);
    }
  });

  test("尾截断后拒绝追加（锚点 fail-closed）", () => {
    const fs = require("node:fs");
    const backup = fs.readFileSync(audit.auditFile(), "utf8");
    const headBackup = fs.existsSync(audit.headFile()) ? fs.readFileSync(audit.headFile(), "utf8") : null;
    try {
      const lines = backup.split("\n").filter(Boolean);
      lines.pop();
      fs.writeFileSync(audit.auditFile(), lines.join("\n") + "\n");
      expect(() => audit.append({ session: "s-trunc", tool: "bash", decision: "allow" })).toThrow(/E_AUDIT_CHAIN/);
      expect(audit.verifyChain().ok).toBe(false);
    } finally {
      fs.writeFileSync(audit.auditFile(), backup);
      if (headBackup === null) fs.rmSync(audit.headFile(), { force: true });
      else fs.writeFileSync(audit.headFile(), headBackup);
    }
  });

  test("并发 append 不分叉链", async () => {
    const { spawn } = require("node:child_process");
    const entry = join(import.meta.dir, "..", "src", "audit.ts");
    const script = `import * as audit from ${JSON.stringify(entry)}; audit.append({ session: "s-conc", tool: "bash", decision: "allow" });`;
    const runs = Array.from({ length: 6 }, () => new Promise<void>((res) => {
      spawn(process.execPath, ["-e", script], { env: process.env, stdio: "ignore" }).on("exit", () => res());
    }));
    await Promise.all(runs);
    const r = audit.verifyChain();
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThanOrEqual(6);
  });
});

describe("verification fixes", () => {
  test("corrupted freeze state fails closed", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.env.DIA_STATE_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "freeze.json"), "{");
    expect(freeze.status().frozen).toBe(true);
    expect(freeze.status().reason).toContain("corrupted");
    freeze.thaw({ reason: "reset", human: true });
  });

  test("audit verify rejects extra rows", () => {
    audit.append({ session: "s-extra", tool: "bash", decision: "allow" });
    audit.append({ session: "s-extra", tool: "bash", decision: "allow" });
    const r = audit.verify("s-extra", 1);
    expect(r.ok).toBe(false);
    expect(r.extra).toBe(1);
  });

  test("resume ignores snapshot from another session", () => {
    freeze.freeze({ reason: "test", by: "auto", session: "s-a" });
    freeze.thaw({ reason: "ok", human: true });
    const card = resume.resumeCard("s-b");
    expect(card.cwd).toBeNull();
  });
});

describe("audit hash chain", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  let backup: string | null = null;
  let backupHead: string | null = null;

  const readLines = () => fs.readFileSync(audit.auditFile(), "utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  const writeLines = (lines: any[]) => fs.writeFileSync(audit.auditFile(), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // the head anchor lives next to the log — reset it with the log or state leaks between cases
  const resetLog = () => {
    fs.mkdirSync(path.dirname(audit.auditFile()), { recursive: true });
    fs.writeFileSync(audit.auditFile(), "");
    fs.rmSync(audit.headFile(), { force: true });
    fs.rmSync(path.join(path.dirname(audit.auditFile()), ".lock"), { recursive: true, force: true });
  };
  const cli = (args: string[]) =>
    require("node:child_process").spawnSync(process.execPath, ["src/cli.ts", "audit", ...args], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, DIA_DATA_DIR: process.env.DIA_DATA_DIR, DIA_STATE_DIR: process.env.DIA_STATE_DIR },
      encoding: "utf8",
    });

  beforeAll(() => {
    backup = fs.existsSync(audit.auditFile()) ? fs.readFileSync(audit.auditFile(), "utf8") : null;
    backupHead = fs.existsSync(audit.headFile()) ? fs.readFileSync(audit.headFile(), "utf8") : null;
  });
  afterAll(() => {
    if (backup === null) fs.rmSync(audit.auditFile(), { force: true });
    else fs.writeFileSync(audit.auditFile(), backup);
    if (backupHead === null) fs.rmSync(audit.headFile(), { force: true });
    else fs.writeFileSync(audit.headFile(), backupHead);
  });

  test("append links rows into a valid chain", () => {
    resetLog();
    const evs = [0, 1, 2].map(() => audit.append({ session: "c-ok", tool: "bash", decision: "allow" }));
    expect(evs[0].prev_hash).toBe(audit.GENESIS);
    expect(evs[0].hash).toHaveLength(audit.HASH_LEN);
    expect(evs[1].prev_hash).toBe(evs[0].hash);
    expect(evs[2].prev_hash).toBe(evs[1].hash);
    expect(evs.map((e: any) => e.seq)).toEqual([1, 2, 3]);
    const c = audit.verifyChain();
    expect(c.ok).toBe(true);
    expect(c.checked).toBe(3);
    expect(c.legacy).toBe(0);
    expect(c.broken_at).toBeNull();
    const v = audit.verify("c-ok", 3, { chain: true });
    expect(v.ok).toBe(true);
    expect(v.reconciled).toBe(true);
    expect(v.chain.ok).toBe(true);
  });

  test("tampering with a field is detected", () => {
    resetLog();
    for (let i = 0; i < 3; i++) audit.append({ session: "c-tamper", tool: "bash", decision: "allow" });
    const lines = readLines();
    lines[1].decision = "deny";
    writeLines(lines);
    const c = audit.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.broken_at).toBe(2);
    expect(c.reason).toContain("hash mismatch");
    const v = audit.verify("c-tamper", 3, { chain: true });
    expect(v.ok).toBe(false);
    expect(v.reconciled).toBe(true);
    expect(v.chain.ok).toBe(false);
  });

  test("params_hash tampering is detected", () => {
    resetLog();
    for (let i = 0; i < 2; i++) audit.append({ session: "c-params", tool: "bash", decision: "allow" });
    const lines = readLines();
    lines[0].params_hash = "deadbeefdeadbeef";
    writeLines(lines);
    const c = audit.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.broken_at).toBe(1);
  });

  test("deleting a middle row is detected", () => {
    resetLog();
    for (let i = 0; i < 3; i++) audit.append({ session: "c-drop", tool: "bash", decision: "allow" });
    const lines = readLines();
    lines.splice(1, 1);
    writeLines(lines);
    const c = audit.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.broken_at).toBe(2);
    expect(c.reason).toMatch(/seq gap|prev_hash mismatch/);
  });

  test("swapped prev_hash is detected", () => {
    resetLog();
    for (let i = 0; i < 3; i++) audit.append({ session: "c-swap", tool: "bash", decision: "allow" });
    const lines = readLines();
    const a = lines[1].prev_hash;
    lines[1].prev_hash = lines[2].prev_hash;
    lines[2].prev_hash = a;
    writeLines(lines);
    const c = audit.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.broken_at).toBe(2);
    expect(c.reason).toContain("prev_hash mismatch");
  });

  test("empty file and single-row boundaries", () => {
    resetLog();
    const empty = audit.verifyChain();
    expect(empty.ok).toBe(true);
    expect(empty.total).toBe(0);
    expect(empty.checked).toBe(0);
    audit.append({ session: "c-one", tool: "bash", decision: "allow" });
    const one = audit.verifyChain();
    expect(one.ok).toBe(true);
    expect(one.total).toBe(1);
    expect(one.checked).toBe(1);
  });

  test("legacy rows without hash remain valid as a chain prefix", () => {
    resetLog();
    fs.writeFileSync(
      audit.auditFile(),
      JSON.stringify({ ts: new Date().toISOString(), session: "c-legacy", tool: "bash", params_hash: "0123456789abcdef", decision: "allow" }) + "\n",
    );
    const ev = audit.append({ session: "c-legacy", tool: "bash", decision: "allow" });
    expect(ev.prev_hash).toBe(audit.GENESIS);
    expect(ev.seq).toBe(2);
    const c = audit.verifyChain();
    expect(c.ok).toBe(true);
    expect(c.legacy).toBe(1);
    expect(c.checked).toBe(1);
  });

  test("append records the head anchor atomically", () => {
    resetLog();
    const ev = audit.append({ session: "c-head", tool: "bash", decision: "allow" });
    const head = JSON.parse(fs.readFileSync(audit.headFile(), "utf8"));
    expect(head.last_seq).toBe(1);
    expect(head.last_hash).toBe(ev.hash);
    expect(head.row_count).toBe(1);
    // no temp residue next to the anchor
    expect(fs.readdirSync(path.dirname(audit.headFile())).filter((f: string) => f.endsWith(".tmp"))).toEqual([]);
    const c = audit.verifyChain();
    expect(c.head_seq).toBe(1);
    expect(c.head_hash).toBe(ev.hash);
    expect(c.tail_truncated).toBe(false);
  });

  test("deleting the last 1..N rows is detected as tail truncation", () => {
    for (const drop of [1, 2, 3]) {
      resetLog();
      for (let i = 0; i < 5; i++) audit.append({ session: "c-trunc", tool: "bash", decision: "allow" });
      const lines = readLines();
      writeLines(lines.slice(0, lines.length - drop));
      const c = audit.verifyChain();
      expect(c.ok).toBe(false);
      expect(c.tail_truncated).toBe(true);
      expect(c.reason).toContain("tail truncated");
      expect(c.reason).toContain("anchor seq 5");
      expect(c.head_seq).toBe(5 - drop);
      const v = audit.verify("c-trunc", 5 - drop, { chain: true });
      expect(v.reconciled).toBe(true);
      expect(v.ok).toBe(false);
      expect(v.chain.tail_truncated).toBe(true);
    }
  });

  test("rolling the log back to an earlier valid prefix is detected", () => {
    resetLog();
    for (let i = 0; i < 2; i++) audit.append({ session: "c-roll", tool: "bash", decision: "allow" });
    const prefix = readLines();
    expect(audit.verifyChain().ok).toBe(true);
    for (let i = 0; i < 3; i++) audit.append({ session: "c-roll", tool: "bash", decision: "allow" });
    expect(audit.verifyChain().ok).toBe(true);
    // the restored prefix is internally valid on its own, only the anchor can tell
    writeLines(prefix);
    const c = audit.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.tail_truncated).toBe(true);
    expect(c.reason).toMatch(/tail truncated|chain head mismatch/);
    expect(c.head_seq).toBe(2);
  });

  test("a missing anchor on a chained log fails closed", () => {
    resetLog();
    for (let i = 0; i < 3; i++) audit.append({ session: "c-anchor", tool: "bash", decision: "allow" });
    fs.rmSync(audit.headFile(), { force: true });
    const missing = audit.verifyChain();
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("anchor missing");
    expect(audit.verify("c-anchor", 3, { chain: true }).ok).toBe(false);
    // 锚点缺失时不能拿当前尾部重建（会把截断证据抹掉）→ 拒绝追加（fail-closed）
    expect(() => audit.append({ session: "c-anchor", tool: "bash", decision: "allow" })).toThrow(/E_AUDIT_CHAIN/);
  });

  test("a corrupted anchor fails closed", () => {
    resetLog();
    for (let i = 0; i < 2; i++) audit.append({ session: "c-badhead", tool: "bash", decision: "allow" });
    for (const bad of ["{ not json", JSON.stringify({ last_seq: "x", last_hash: "y", row_count: 1 }), ""]) {
      fs.writeFileSync(audit.headFile(), bad);
      const c = audit.verifyChain();
      expect(c.ok).toBe(false);
      expect(c.reason).toContain("anchor corrupted");
    }
    expect(audit.verify("c-badhead", 2, { chain: true }).ok).toBe(false);
    // CLI agrees: fail-closed anchor -> exit 1
    const r = cli(["verify", "--session", "c-badhead", "--calls", "2", "--chain", "--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).chain.ok).toBe(false);
    expect(JSON.parse(r.stdout).chain.reason).toContain("anchor corrupted");
  });

  test("stale lock is reclaimed, live lock times out fail-closed", () => {
    resetLog();
    audit.append({ session: "c-lock", tool: "bash", decision: "allow" });
    const lock = path.join(path.dirname(audit.auditFile()), ".lock");
    // 1) abandoned lock from a dead pid + old mtime -> reclaimed, append proceeds
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), "999999\n");
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(lock, old, old);
    const ev = audit.append({ session: "c-lock", tool: "bash", decision: "allow" });
    expect(ev.seq).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
    expect(audit.verifyChain().ok).toBe(true);
    // 2) fresh lock held by a live pid -> timeout, append refused (no fork, no row)
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), process.pid + "\n");
    process.env.DIA_AUDIT_LOCK_TIMEOUT_MS = "60";
    try {
      expect(() => audit.append({ session: "c-lock", tool: "bash", decision: "allow" })).toThrow(/lock timeout/);
    } finally {
      delete process.env.DIA_AUDIT_LOCK_TIMEOUT_MS;
      fs.rmSync(lock, { recursive: true, force: true });
    }
    expect(readLines()).toHaveLength(2);
    expect(audit.verifyChain().ok).toBe(true);
  });

  test("concurrent appenders from separate processes stay serialised", async () => {
    resetLog();
    const dir = fs.mkdtempSync(join(tmpdir(), "dia-audit-conc-"));
    const scriptPath = path.join(dir, "writer.ts");
    const auditPath = path.join(import.meta.dir, "..", "src", "audit.ts");
    fs.writeFileSync(scriptPath, [
      `import { append } from ${JSON.stringify(auditPath)};`,
      "const n = Number(process.argv[2]); const tag = process.argv[3];",
      "for (let i = 0; i < n; i++) append({ session: `c-conc-${tag}`, tool: 'bash', decision: 'allow' });",
    ].join("\n"));
    const env = { ...process.env, DIA_DATA_DIR: process.env.DIA_DATA_DIR, DIA_STATE_DIR: process.env.DIA_STATE_DIR };
    const spawn = require("node:child_process").spawn;
    const codes = await Promise.all(
      [0, 1, 2, 3].map((i) => new Promise<number | null>((resolve) => {
        const p = spawn(process.execPath, [scriptPath, "5", String(i)], { env, stdio: "ignore" });
        p.on("exit", (code: number | null) => resolve(code));
      })),
    );
    expect(codes).toEqual([0, 0, 0, 0]);
    const lines = readLines();
    expect(lines).toHaveLength(20);
    const seqs = lines.map((l: any) => l.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_v, i) => i + 1));
    expect(new Set(seqs).size).toBe(20);
    const c = audit.verifyChain();
    expect(c.ok).toBe(true);
    expect(c.checked).toBe(20);
    expect(c.head_seq).toBe(20);
    expect(c.tail_truncated).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(audit.auditFile()), ".lock"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("CLI --chain reports tail truncation with exit code 1", () => {
    resetLog();
    for (let i = 0; i < 3; i++) audit.append({ session: "c-cli2", tool: "bash", decision: "allow" });
    const lines = readLines();
    writeLines(lines.slice(0, 2));
    const r = cli(["verify", "--session", "c-cli2", "--calls", "2", "--chain", "--json"]);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.reconciled).toBe(true);
    expect(out.chain.ok).toBe(false);
    expect(out.chain.tail_truncated).toBe(true);
    expect(out.chain.reason).toContain("tail truncated");
    expect(out.chain.head_seq).toBe(2);
  });

  test("CLI --chain passes through and drives the exit code", () => {
    resetLog();
    for (let i = 0; i < 2; i++) audit.append({ session: "c-cli", tool: "bash", decision: "allow" });
    const good = cli(["verify", "--session", "c-cli", "--calls", "2", "--chain", "--json"]);
    expect(good.status).toBe(0);
    const goodOut = JSON.parse(good.stdout);
    expect(goodOut.ok).toBe(true);
    expect(goodOut.reconciled).toBe(true);
    expect(goodOut.chain.ok).toBe(true);
    expect(goodOut.chain.checked).toBe(2);
    // without --chain the reconciliation verdict is unchanged (no chain field)
    const plain = cli(["verify", "--session", "c-cli", "--calls", "2", "--json"]);
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout).chain).toBeUndefined();
    // tamper one row -> chain broken -> exit 1
    const lines = readLines();
    lines[0].decision = "deny";
    writeLines(lines);
    const bad = cli(["verify", "--session", "c-cli", "--calls", "2", "--chain", "--json"]);
    expect(bad.status).toBe(1);
    const badOut = JSON.parse(bad.stdout);
    expect(badOut.reconciled).toBe(true);
    expect(badOut.chain.ok).toBe(false);
    expect(badOut.chain.broken_at).toBe(1);
  });
});

describe("freeze", () => {
  test("agent-side thaw is refused 10 times", () => {
    freeze.freeze({ reason: "test", by: "auto" });
    for (let i = 0; i < 10; i++) {
      expect(() => freeze.thaw({ reason: "agent tries", human: false })).toThrow();
    }
    expect(freeze.status().frozen).toBe(true);
  });

  test("human thaw works with reason", () => {
    freeze.freeze({ reason: "test", by: "auto" });
    const r = freeze.thaw({ reason: "reviewed by owner", human: true });
    expect(r.thawed).toBe(true);
    expect(freeze.status().frozen).toBe(false);
  });

  test("thaw requires a reason", () => {
    freeze.freeze({ reason: "test", by: "auto" });
    expect(() => freeze.thaw({ reason: "", human: true })).toThrow();
  });
});
