import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], session?: string) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: {
    ...process.env as Record<string, string>,
    DIA_ROOT: root,
    DIA_SESSION_ID: session || "",
    OPENCODE_SESSION_ID: "",
  },
});
const json = (s: string) => JSON.parse(s);

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "dia-claims-")); });

describe("dia claim（advisory）", () => {
  test("同一路径两个会话 claim：第二个看到 overlap，exit 0，JSONL 两行", () => {
    const a = run(["claim", "README.md", "--reason", "A", "--json"], "ses_a");
    expect(a.status).toBe(0);
    const b = run(["claim", "README.md", "--reason", "B", "--json"], "ses_b");
    expect(b.status).toBe(0);
    const r = json(b.stdout);
    expect(r.overlaps.length).toBe(1);
    expect(r.overlaps[0].holder).toBe("ses_a");
    const lines = readFileSync(join(root, "collab", "claims.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("TTL 过期后不在活跃列表，--all 仍可见", () => {
    run(["claim", "docs/", "--ttl", "1s", "--json"], "ses_a");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    const active = json(run(["claims", "--json"], "ses_a").stdout);
    expect(active.some((c: any) => c.path === "docs")).toBe(false);
    const all = json(run(["claims", "--all", "--json"], "ses_a").stdout);
    expect(all.some((c: any) => c.path === "docs")).toBe(true);
  });

  test("非 holder 不能 unclaim，--force 可以", () => {
    const c = json(run(["claim", "package.json", "--json"], "ses_a").stdout).claim;
    const denied = run(["unclaim", c.id], "ses_b");
    expect(denied.status).toBe(22);
    expect(denied.stderr).toContain("E_CLAIM_OWNER");
    const forced = run(["unclaim", c.id, "--force"], "ses_b");
    expect(forced.status).toBe(0);
  });

  test("路径穿越被拒绝；无 session 明确报错", () => {
    const bad = run(["claim", "../outside"], "ses_a");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("E_CLAIM_PATH");
    const noSession = run(["claim", "README.md"]);
    expect(noSession.status).toBe(2);
    expect(noSession.stderr).toContain("E_NO_SESSION");
  });
});
