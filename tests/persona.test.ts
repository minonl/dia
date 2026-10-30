import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let persona: any;
let src: string, data: string, agents: string, cache: string, dshProfiles: string;

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "dia-p-data-"));
  agents = mkdtempSync(join(tmpdir(), "dia-p-agents-"));
  cache = mkdtempSync(join(tmpdir(), "dia-p-cache-"));
  dshProfiles = mkdtempSync(join(tmpdir(), "dia-p-dsh-"));
  process.env.DIA_DATA_DIR = data;
  process.env.DIA_OPENCODE_AGENTS_DIR = agents;
  process.env.DIA_CACHE_DIR = cache;
  process.env.DIA_DSH_PROFILES_DIR = dshProfiles;
  persona = await import("../src/persona.ts");
  src = mkdtempSync(join(tmpdir(), "dia-p-src-"));
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "dabo", version: "0.1.0",
    hosts: ["opencode"], entry: { opencode: "agents/dabo.md" },
  }));
  writeFileSync(join(src, "agents", "dabo.md"), "---\ndescription: dabo\nmode: primary\n---\nYou are dabo.\n");
});

describe("persona", () => {
  test("dry-run writes nothing", () => {
    const r = persona.install(src, { dryRun: true });
    expect(r.hash).toBe("dry-run");
    expect(existsSync(join(agents, "dabo.md"))).toBe(false);
  });

  test("add renders opencode agent", () => {
    const r = persona.install(src);
    expect(r.id).toBe("dabo");
    expect(existsSync(join(agents, "dabo.md"))).toBe(true);
    expect(persona.list()[0].id).toBe("dabo");
    expect(persona.verify("dabo").ok).toBe(true);
  });

  test("conflicting agent file is refused", () => {
    writeFileSync(join(agents, "dabo.md"), "user edited\n");
    expect(() => persona.install(src)).toThrow(/E_CONFLICT/);
  });

  test("remove deletes rendered file", () => {
    // restore managed file first
    writeFileSync(join(agents, "dabo.md"), "---\ndescription: dabo\nmode: primary\n---\nYou are dabo.\n");
    const r = persona.remove("dabo");
    expect(r.removed.length).toBe(1);
    expect(existsSync(join(agents, "dabo.md"))).toBe(false);
  });
});

describe("persona security regressions", () => {
  test("remove refuses non-matching rendered path (yan protection)", () => {
    persona.install(src);
    const yan = join(agents, "yan.md");
    writeFileSync(yan, "user yan\n");
    const lockPath = join(data, "personas", "dabo", "0.1.0", "dia.lock");
    const lock = JSON.parse(require("node:fs").readFileSync(lockPath, "utf8"));
    lock.rendered = [...(lock.rendered || []), yan];
    writeFileSync(lockPath, JSON.stringify(lock));
    const r = persona.remove("dabo");
    expect(r.removed).not.toContain(yan);
    expect(require("node:fs").existsSync(yan)).toBe(true);
  });

  test("verify catches rendered file tamper", () => {
    persona.install(src);
    writeFileSync(join(agents, "dabo.md"), "tampered\n");
    expect(persona.verify("dabo").ok).toBe(false);
  });

  test("rejects symlink entry", () => {
    const bad = mkdtempSync(join(tmpdir(), "dia-p-link-"));
    mkdirSync(join(bad, "agents"), { recursive: true });
    writeFileSync(join(bad, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "evil3", version: "1.0.0",
      hosts: ["opencode"], entry: { opencode: "agents/link.md" },
    }));
    require("node:fs").symlinkSync("/etc/hosts", join(bad, "agents", "link.md"));
    expect(() => persona.install(bad)).toThrow(/symlink/);
  });
});

describe("persona dsh render", () => {
  test("renders dsh profile and removes it", () => {
    const both = mkdtempSync(join(tmpdir(), "dia-p-both-"));
    mkdirSync(join(both, "agents"), { recursive: true });
    mkdirSync(join(both, "dsh"), { recursive: true });
    writeFileSync(join(both, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "both", version: "1.0.0",
      hosts: ["opencode", "dsh"], entry: { opencode: "agents/both.md", dsh: "dsh" },
    }));
    writeFileSync(join(both, "agents", "both.md"), "---\ndescription: both\nmode: primary\n---\nboth\n");
    writeFileSync(join(both, "dsh", "package.json"), "{}");
    writeFileSync(join(both, "dsh", "cordis.patch.yml"), "[]\n");
    persona.install(both);
    expect(require("node:fs").existsSync(join(dshProfiles, "both", "cordis.patch.yml"))).toBe(true);
    expect(require("node:fs").existsSync(join(dshProfiles, "both", ".dia-managed"))).toBe(true);
    expect(persona.verify("both").ok).toBe(true);
    const r = persona.remove("both");
    expect(r.removed.some((x: string) => x.includes("both"))).toBe(true);
    expect(require("node:fs").existsSync(join(dshProfiles, "both"))).toBe(false);
  });
});

describe("persona path safety", () => {
  test("rejects path traversal in version", () => {
    const bad = mkdtempSync(join(tmpdir(), "dia-p-bad-"));
    mkdirSync(join(bad, "agents"), { recursive: true });
    writeFileSync(join(bad, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "evil", version: "1.0.0/../../x",
      hosts: ["opencode"], entry: { opencode: "agents/x.md" },
    }));
    writeFileSync(join(bad, "agents", "x.md"), "x\n");
    expect(() => persona.install(bad)).toThrow(/bad version|escapes/);
  });

  test("rejects entry escaping persona dir", () => {
    const bad = mkdtempSync(join(tmpdir(), "dia-p-bad2-"));
    const outside = join(bad, "..", "outside-entry.md");
    writeFileSync(outside, "outside\n");
    writeFileSync(join(bad, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "evil2", version: "1.0.0",
      hosts: ["opencode"], entry: { opencode: "../outside-entry.md" },
    }));
    expect(() => persona.install(bad)).toThrow(/escapes/);
  });
});
