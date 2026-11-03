import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let deps: any;

beforeAll(async () => { deps = await import("../src/deps.ts"); });

describe("deps.jsonl 读取", () => {
  test("同一 id 取最后一行；坏行跳过", () => {
    // 版本在 id 后面：加载时收敛到最新一行
    const dir = mkdtempSync(join(tmpdir(), "dia-deps-"));
    const p = join(dir, "deps.jsonl");
    writeFileSync(p, [
      JSON.stringify({ id: "host_cli:x", kind: "host_cli", version: "1.0.0", role: "optional" }),
      "not json",
      JSON.stringify({ id: "host_cli:x", kind: "host_cli", version: "2.0.0", role: "optional" }),
    ].join("\n") + "\n");
    const rows = deps.load(p);
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe("2.0.0");

    const p2 = join(dir, "deps2.jsonl");
    writeFileSync(p2, [
      JSON.stringify({ id: "host_cli:x@1.0.0", kind: "host_cli", version: "1.0.0", role: "required" }),
      JSON.stringify({ id: "host_cli:x@2.0.0", kind: "host_cli", version: "2.0.0", role: "required" }),
    ].join("\n") + "\n");
    const rows2 = deps.load(p2);
    expect(rows2.length).toBe(1);
    expect(rows2[0].version).toBe("2.0.0");
  });
});

describe("依赖校验", () => {
  const fakeBin = (version: string) => {
    const dir = mkdtempSync(join(tmpdir(), "dia-bin-"));
    const p = join(dir, "fakehost");
    writeFileSync(p, `#!/bin/sh\necho "fakehost v${version}"\n`);
    chmodSync(p, 0o755);
    return { dir, p };
  };

  test("版本一致 → ok", () => {
    const { dir, p } = fakeBin("2.2.5");
    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    try {
      const r = deps.check({ id: "host_cli:fakehost@2.2.5", kind: "host_cli", version: "2.2.5", role: "required" });
      expect(r.status).toBe("ok");
      expect(r.detail).toContain("2.2.5");
      expect(p).toBeTruthy();
    } finally { process.env.PATH = old; }
  });

  test("版本不符 → warn", () => {
    const { dir } = fakeBin("2.2.5");
    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    try {
      const r = deps.check({ id: "host_cli:fakehost@9.9.9", kind: "host_cli", version: "9.9.9", role: "required" });
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("9.9.9");
    } finally { process.env.PATH = old; }
  });

  test("required 缺失 → fail；optional 缺失 → ok + note", () => {
    const missing = "definitely-not-a-real-binary-xyz";
    expect(deps.check({ id: `host_cli:${missing}@1.0.0`, kind: "host_cli", version: "1.0.0", role: "required" }).status).toBe("fail");
    const opt = deps.check({ id: `host_cli:${missing}@1.0.0`, kind: "host_cli", version: "1.0.0", role: "optional" });
    expect(opt.status).toBe("ok");
    expect(opt.note).toBe(true);
  });

  test("summary 汇总状态", () => {
    const rows = [
      { id: "host_cli:definitely-not-a-real-binary-xyz@1.0.0", kind: "host_cli", version: "1.0.0", role: "required" },
      { id: "datastore:none", kind: "datastore", version: "unknown", resolved: "/nope/none.db", role: "optional" },
    ];
    const s = deps.summary(rows);
    expect(s.status).toBe("fail");
    expect(s.detail).toContain("缺 1");
  });
});
