import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const run = (args: string[], session?: string) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env as Record<string, string>, DIA_ROOT: root, DIA_SESSION_ID: session || "", OPENCODE_SESSION_ID: "" },
});
const json = (s: string) => JSON.parse(s);

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "dia-handoff-claim-")); });

describe("handoff + claim 联动", () => {
  test("out --touches 提示他人 claim 并写入 refs", () => {
    run(["claim", "src/x.ts", "--reason", "A 在改", "--json"], "ses_a");
    const r = run(["out", "--to", "ses_c", "--subject", "交接", "--body", "请看", "--touches", "src/x.ts", "--json"], "ses_b");
    expect(r.status).toBe(0);
    const m = json(r.stdout);
    expect(m.refs.touches).toBe("src/x.ts");
    expect(m.claim_overlaps.length).toBe(1);
    expect(m.claim_overlaps[0].holder).toBe("ses_a");
  });

  test("收件方 dia in 显示 claim 告警", () => {
    const r = run(["in"], "ses_c");
    expect(r.stdout).toContain("⚠ claim: src/x.ts");
    expect(r.stdout).toContain("ses_a");
  });
});
