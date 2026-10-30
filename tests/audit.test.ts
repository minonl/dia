import { describe, expect, test, beforeAll } from "bun:test";
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
    const lines = fs.readFileSync(audit.auditFile(), "utf8").split("\n").filter(Boolean);
    const idx = lines.findIndex((l: string) => l.includes('"s-run5"'));
    lines.splice(idx, 1);
    fs.writeFileSync(audit.auditFile(), lines.join("\n") + "\n");
    expect(audit.verify("s-run5", rt.countCalls("s-run5")).ok).toBe(false);
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
    const lines = fs.readFileSync(audit.auditFile(), "utf8").split("\n").filter(Boolean);
    const idx = lines.findIndex((l: string) => l.includes('"s-h3"'));
    lines.splice(idx, 1);
    fs.writeFileSync(audit.auditFile(), lines.join("\n") + "\n");
    const card = resume.resumeCard("s-h3");
    expect(card.audit_ok).toBe(false);
    expect(card.audit_gap).toBe(1);
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
