import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const baseEnv = () => {
  const env = { ...process.env } as Record<string, string>;
  delete env.OPENCODE_SESSION_ID;
  delete env.DIA_SESSION_ID;
  env.DIA_ROOT = root;
  return env;
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-beat-")); });

describe("dia beat", () => {
  test("写入 beats.jsonl 并带 track/note", () => {
    const r = spawnSync("bun", [cli, "beat", "--session", "ses_x", "--track", "tr-a", "--note", "n", "--json"], { encoding: "utf8", env: baseEnv() });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).session).toBe("ses_x");
    const line = JSON.parse(readFileSync(join(root, "workbench", "beats.jsonl"), "utf8").trim());
    expect(line.session).toBe("ses_x");
    expect(line.track).toBe("tr-a");
    expect(line.note).toBe("n");
  });

  test("没有会话标识 → exit 2，不写文件", () => {
    const r = spawnSync("bun", [cli, "beat"], { encoding: "utf8", env: baseEnv() });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("E_NO_SESSION");
    expect(existsSync(join(root, "workbench", "beats.jsonl"))).toBe(false);
  });
});
