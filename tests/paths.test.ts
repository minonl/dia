import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const run = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });

describe("paths：单一数据根", () => {
  test("不设任何 DIA_* 时落在 ~/.dia", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-paths-home-"));
    const r = run(["msg", "send", "ops", "--from", "me", "--kind", "notify", "--subject", "s"], {
      HOME: home,
      PATH: process.env.PATH || "/usr/bin:/bin",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".dia", "msg", "ops"))).toBe(true);
    expect(existsSync(join(home, ".local", "share", "dia"))).toBe(false);
  });

  test("DIA_ROOT 覆盖；DIA_MSG_ROOT 被忽略", () => {
    const home = mkdtempSync(join(tmpdir(), "dia-paths-home2-"));
    const root = mkdtempSync(join(tmpdir(), "dia-paths-root-"));
    const ignored = mkdtempSync(join(tmpdir(), "dia-paths-ignore-"));
    const r = run(["msg", "send", "ops", "--from", "me", "--kind", "notify", "--subject", "s"], {
      HOME: home,
      DIA_ROOT: root,
      DIA_MSG_ROOT: ignored,
      PATH: process.env.PATH || "/usr/bin:/bin",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "msg", "ops"))).toBe(true);
    expect(existsSync(join(ignored, "ops"))).toBe(false);
  });
});
