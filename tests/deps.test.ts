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

  test("登记 2.2.x 容忍补丁漂移（实测 2.2.5 → ok）", () => {
    const { dir } = fakeBin("2.2.5");
    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    try {
      const r = deps.check({ id: "host_cli:fakehost@2.2.x", kind: "host_cli", version: "2.2.x", role: "required" });
      expect(r.status).toBe("ok");
    } finally { process.env.PATH = old; }
  });

  test("主.次不匹配（登记 2.3.x，实测 2.2.5）→ warn", () => {
    const { dir } = fakeBin("2.2.5");
    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    try {
      const r = deps.check({ id: "host_cli:fakehost@2.3.x", kind: "host_cli", version: "2.3.x", role: "required" });
      expect(r.status).toBe("warn");
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

  test("host_cli required 缺失 → warn（缺宿主最多告警，不判 fail）；optional 缺失 → ok + note", () => {
    const missing = "definitely-not-a-real-binary-xyz";
    const req = deps.check({ id: `host_cli:${missing}@1.0.0`, kind: "host_cli", version: "1.0.0", role: "required" });
    expect(req.status).toBe("warn");
    expect(req.detail).toContain("本机未装宿主");
    const opt = deps.check({ id: `host_cli:${missing}@1.0.0`, kind: "host_cli", version: "1.0.0", role: "optional" });
    expect(opt.status).toBe("ok");
    expect(opt.note).toBe(true);
  });

  test("已安装 service 依赖该宿主 → 缺宿主升 fail（required/optional 都算）", () => {
    const missing = "definitely-not-a-real-binary-xyz";
    const hosts = new Map([[missing, ["svc-a", "svc-b"]]]);
    const req = deps.check({ id: `host_cli:${missing}@1.0.0`, kind: "host_cli", version: "1.0.0", role: "required" }, { requiredHosts: hosts });
    expect(req.status).toBe("fail");
    expect(req.detail).toContain("svc-a, svc-b");
    const opt = deps.check({ id: `host_cli:${missing}@1.0.0`, kind: "host_cli", version: "1.0.0", role: "optional" }, { requiredHosts: hosts });
    expect(opt.status).toBe("fail");
  });

  test("非 host_cli 的 required 缺失仍 fail（边界不动）", () => {
    const r = deps.check({ id: "datastore:none", kind: "datastore", version: "unknown", resolved: "/nope/none.db", role: "required" });
    expect(r.status).toBe("fail");
  });

  test("summary 汇总状态", () => {
    const rows = [
      { id: "host_cli:definitely-not-a-real-binary-xyz@1.0.0", kind: "host_cli", version: "1.0.0", role: "required" },
      { id: "datastore:none", kind: "datastore", version: "unknown", resolved: "/nope/none.db", role: "optional" },
    ];
    const s = deps.summary(rows);
    expect(s.status).toBe("warn");
    expect(s.detail).toContain("告警 1");
  });
});

// 2026-11-16（R2）：host_cli 的版本判定权归 platforms 注册表的 range ——
// deps.jsonl 里的 version 只是登记当时的快照，宿主补丁演进不该反复报「漂移」；
// 同时 supported=false 的平台不该把「本机没这个宿主」记成缺陷。
describe("host_cli 版本判定归 platforms 注册表", () => {
  const fakeBin = (version: string) => {
    const dir = mkdtempSync(join(tmpdir(), "dia-bin-reg-"));
    const p = join(dir, "fakehost");
    writeFileSync(p, `#!/bin/sh\necho "fakehost v${version}"\n`);
    chmodSync(p, 0o755);
    return dir;
  };
  const withRegistry = (entry: any, fn: () => void) => {
    const dir = mkdtempSync(join(tmpdir(), "dia-plat-"));
    const file = join(dir, "platforms.json");
    writeFileSync(file, JSON.stringify({ schema: 1, platforms: { fakehost: entry } }));
    const saved = process.env.DIA_PLATFORMS_FILE;
    process.env.DIA_PLATFORMS_FILE = file;
    try { fn(); } finally { if (saved === undefined) delete process.env.DIA_PLATFORMS_FILE; else process.env.DIA_PLATFORMS_FILE = saved; }
  };
  const base = { supported: true, render: null, probe: ["--version"], range: ">=2.2.0 <3.0.0", tested: [], notes: [] };

  test("range 覆盖补丁演进：登记 2.2.5、实测 2.2.9 → ok（不再误报漂移）", () => {
    const dir = fakeBin("2.2.9"); const old = process.env.PATH; process.env.PATH = `${dir}:${old}`;
    try {
      withRegistry(base, () => {
        const r = deps.check({ id: "host_cli:fakehost@2.2.5", kind: "host_cli", version: "2.2.5", role: "required" });
        expect(r.status).toBe("ok");
        expect(r.detail).toContain(">=2.2.0");
      });
    } finally { process.env.PATH = old; }
  });

  test("超出 range → warn（用注册表的范围措辞，不拿旧快照吓人）", () => {
    const dir = fakeBin("3.1.0"); const old = process.env.PATH; process.env.PATH = `${dir}:${old}`;
    try {
      withRegistry(base, () => {
        const r = deps.check({ id: "host_cli:fakehost@2.2.5", kind: "host_cli", version: "2.2.5", role: "required" });
        expect(r.status).toBe("warn");
        expect(r.detail).toContain("platforms 支持范围");
      });
    } finally { process.env.PATH = old; }
  });

  test("注册表声明 supported=false 且未装 → ok + note（本平台没这个宿主，不算缺陷）", () => {
    const old = process.env.PATH; process.env.PATH = "/usr/bin:/bin"; // 保证 fakehost 不可见
    try {
      withRegistry({ ...base, supported: false }, () => {
        const r = deps.check({ id: "host_cli:fakehost@0.2.1", kind: "host_cli", version: "0.2.1", role: "required" });
        expect(r.status).toBe("ok");
        expect(r.note).toBe(true);
      });
    } finally { process.env.PATH = old; }
  });

  test("没有注册表条目时退回登记版本匹配（原行为不变）", () => {
    const dir = fakeBin("2.2.9"); const old = process.env.PATH; process.env.PATH = `${dir}:${old}`;
    try {
      const r = deps.check({ id: "host_cli:fakehost@2.2.5", kind: "host_cli", version: "2.2.5", role: "required" });
      expect(r.status).toBe("warn"); // 精确登记 2.2.5 vs 实测 2.2.9
      expect(r.detail).toContain("登记 2.2.5");
    } finally { process.env.PATH = old; }
  });
});
