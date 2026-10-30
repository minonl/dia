import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let envx: any;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dia-env-"));
  writeFileSync(join(dir, "a.env"), [
    "# 注释",
    'export TOKEN_A="secret-a"',
    "TOKEN_B='secret-b'",
    'QUOTED="has \\"inner\\" quote"',
    "EMPTY=",
  ].join("\n"));
  writeFileSync(join(dir, "b.env"), ["TOKEN_A=override-a"].join("\n"));
  envx = await import("../src/env.ts");
});

describe("dotenv 子集", () => {
  test("引号/export/注释/转义", () => {
    const v = envx.parseFile(join(dir, "a.env"));
    expect(v.TOKEN_A).toBe("secret-a");
    expect(v.TOKEN_B).toBe("secret-b");
    expect(v.QUOTED).toBe('has "inner" quote');
    expect(v.EMPTY).toBe("");
  });

  test("后文件覆盖前文件", () => {
    const v = envx.loadValues({ files: [join(dir, "a.env"), join(dir, "b.env")], keys: [] });
    expect(v.TOKEN_A).toBe("override-a");
  });
});

describe("list / check / run", () => {
  const cfg = () => ({ files: [join(dir, "a.env"), join(dir, "b.env")], keys: ["TOKEN_A", "TOKEN_B", "NOPE"] });

  test("list 不回显值，只报存在性", () => {
    const r = envx.list(cfg());
    expect(r.keys.find((k: any) => k.key === "TOKEN_A").found).toBe(true);
    expect(r.keys.find((k: any) => k.key === "NOPE").found).toBe(false);
    expect(JSON.stringify(r)).not.toContain("override-a");
  });

  test("check 只报长度", () => {
    const r = envx.check(cfg(), ["TOKEN_B"]);
    expect(r[0].length).toBe("secret-b".length);
  });

  test("run 注入子进程，缺键不阻断", () => {
    const r = envx.run(cfg(), ["node", "-e", "process.stdout.write(process.env.TOKEN_A || 'none')"], { redact: true });
    expect(r.exit).toBe(0);
    expect(r.missing).toEqual(["NOPE"]);
    expect(r.injected).toEqual(["TOKEN_A", "TOKEN_B"]);
  });

  test("redact 把值替换成 [REDACTED]", () => {
    const r = envx.run({ files: [join(dir, "a.env")], keys: ["TOKEN_B"] },
      ["node", "-e", "process.stdout.write('v=' + process.env.TOKEN_B)"], { redact: true });
    expect(r.exit).toBe(0);
  });

  test("dry-run 不执行", () => {
    const r = envx.run(cfg(), ["node", "-e", "process.exit(9)"], { dryRun: true });
    expect(r.exit).toBe(0);
    expect(r.injected).toContain("TOKEN_A");
  });

  test("退出码透传", () => {
    const r = envx.run(cfg(), ["node", "-e", "process.exit(7)"]);
    expect(r.exit).toBe(7);
  });
});
