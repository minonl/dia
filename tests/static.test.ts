import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("static safety", () => {
  test("no network modules imported by the framework", () => {
    // node:net 唯一例外：src/bw.ts 的本机 unix socket（credential broker 的进程间通道，不开 TCP 端口）。
    const NET_IPC_ALLOWED = new Set(["bw.ts"]);
    for (const f of walk(SRC)) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/node:https?/);
      if (!NET_IPC_ALLOWED.has(f.split("/").pop()!)) expect(text).not.toMatch(/\bnode:net\b/);
      expect(text).not.toMatch(/\bdgram\b/);
      expect(text).not.toMatch(/\bfetch\(/);
    }
  });
  test("no arbitrary exec in ingest (git-only)", () => {
    const text = readFileSync(join(SRC, "ingest.ts"), "utf8");
    expect(text).not.toMatch(/execSync|spawnSync|\bexec\(/);
    const calls = text.match(/execFileSync\(/g) || [];
    expect(calls.length).toBe(1);
    expect(text).toContain('execFileSync("git"');
  });
});
