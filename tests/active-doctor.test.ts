import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { quoteArg } from "../src/doctor.ts";

let home: string, data: string, src: string;
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
// 依赖登记用独立夹具：CI 上没有 opencode/dsh，不能拿仓库的 deps.jsonl 判 required 缺失
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_HOME: home, DIA_DATA_DIR: data, DIA_DEPS_FILE: join(data, "deps.jsonl"),
    DIA_OPENCODE_AGENTS_DIR: join(home, ".config/opencode/agents"), DIA_CACHE_DIR: join(data, "cache"),
    DIA_OPENCODE_CONFIG: join(home, "opencode.json"), ...env },
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dia-act-home-"));
  data = mkdtempSync(join(tmpdir(), "dia-act-data-"));
  src = mkdtempSync(join(tmpdir(), "dia-act-src-"));
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "agents", "yan.md"), "---\ndescription: yan\nmode: primary\n---\nYou are yan.\n");
  writeFileSync(join(home, "opencode.json"), JSON.stringify({ model: "m" }, null, 2) + "\n");
  // 可选依赖缺失 = ok（不拉红），保证 doctor 判定只受 persona 状态影响
  writeFileSync(join(data, "deps.jsonl"),
    JSON.stringify({ id: "host_cli:ci-noop@1.0.0", kind: "host_cli", version: "1.0.0", role: "optional" }) + "\n");
});

function writePersona(version: string) {
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "yan", version, hosts: ["opencode"], entry: { opencode: "agents/yan.md" },
    files: [{ from: "agents/yan.md", to: "~/.config/opencode/AGENTS.md" }],
  }));
}

describe("生效版本指针（A）", () => {
  test("装两个版本，默认生效最新", () => {
    writePersona("0.1.0"); expect(run(["persona", "add", "--from", src]).status).toBe(0);
    writePersona("0.2.0"); expect(run(["persona", "add", "--from", src]).status).toBe(0);
    const r = run(["persona", "show", "yan"], { DIA_PERSONA: "yan" });
    expect(r.stdout).toContain("0.2.0");
    expect(r.stdout).toContain("最新安装");
  });

  test("use 指定旧版本 → 指针生效 + 写审计", () => {
    const r = run(["persona", "use", "yan@0.1.0", "--reason", "回滚演练"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("→ 0.1.0");
    const audit = readFileSync(join(data, "state", "active.jsonl"), "utf8").trim().split("\n");
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]).reason).toBe("回滚演练");
  });

  test("scope 跟着 active 指针走，而不是最新", () => {
    const r = run(["kb", "get", "x.md"], { DIA_PERSONA: "yan" });
    // 用 persona show 的生效来源断言更直接
    expect(run(["persona", "show", "yan"]).stdout).toContain("active 指针");
  });

  test("use 未安装的版本 → E_VERSION", () => {
    const r = run(["persona", "use", "yan@9.9.9"]);
    expect(r.status).toBe(21);
    expect(r.stderr).toContain("E_VERSION");
  });
});

describe("dia doctor", () => {
  test("全绿时 verdict=ok（default_agent 未设 → warn）", () => {
    run(["persona", "default", "yan"]);
    const r = run(["doctor", "--persona", "yan", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.persona).toBe("yan");
    expect(d.checks.find((c: any) => c.name === "persona.verify").status).toBe("ok");
    expect(d.checks.find((c: any) => c.name === "default_agent").status).toBe("ok");
    expect(r.status).toBeLessThanOrEqual(1);
  });

  test("persona.render：全绿 ok；手改宿主产物 → warn（detail 含路径），恢复后回 ok", () => {
    const dest = join(home, ".config/opencode/AGENTS.md");
    const before = readFileSync(dest, "utf8");
    const pick = (out: string) =>
      JSON.parse(out).checks.find((c: any) => c.name === "persona.render");

    const ok = pick(run(["doctor", "--persona", "yan", "--json"]).stdout);
    expect(ok.status).toBe("ok");
    expect(ok.detail).not.toContain("跳过");

    writeFileSync(dest, before + "\n手改\n");
    try {
      const r = run(["doctor", "--persona", "yan", "--json"]);
      const c = pick(r.stdout);
      expect(["warn", "fail"]).toContain(c.status);
      expect(c.detail).toContain(dest);
      expect(c.detail).toContain("changed");
      // 只读：doctor 不得把产物写回（写回是 `dia persona render` 的职责）
      expect(readFileSync(dest, "utf8")).toBe(before + "\n手改\n");
      // verify 仍按「内容完整性」判 fail，退出码语义不变（2）
      expect(JSON.parse(r.stdout).verdict).toBe("fail");
      expect(r.status).toBe(2);
    } finally {
      writeFileSync(dest, before);
    }

    const back = pick(run(["doctor", "--persona", "yan", "--json"]).stdout);
    expect(back.status).toBe("ok");
  });

  test("平台版本自检：opencode/dsh 只报告，不判红", () => {
    const r = run(["doctor", "--json"]);
    const d = JSON.parse(r.stdout);
    for (const name of ["platform:opencode", "platform:dsh"]) {
      const c = d.checks.find((x: any) => x.name === name);
      expect(c).toBeTruthy();
      expect(["ok", "warn"]).toContain(c.status);
    }
    expect(d.verdict).not.toBe("fail");
  });

  test("产物被改 → doctor fail（exit 2）", () => {
    expect(existsSync(join(home, ".config/opencode/AGENTS.md"))).toBe(true);
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "tampered\n");
    const r = run(["doctor", "--persona", "yan", "--json"]);
    expect(JSON.parse(r.stdout).verdict).toBe("fail");
    expect(r.status).toBe(2);
  });

  test("未引用的孤儿 kit 不拖红 doctor", () => {
    // 上个用例故意改坏了 AGENTS.md，先恢复，避免被它带成 fail
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), ["---", "description: yan", "mode: primary", "---", "You are yan.", ""].join("\n"));
    const orphan = join(data, "kits", "orphan", "0.1.0");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "kit.lock"), JSON.stringify({ id: "orphan", version: "0.1.0", hash: "x", rendered: [
      { path: join(home, ".agents/skills/orphan"), type: "link", value: "skills/orphan" },
    ] }));
    const r = run(["doctor", "--persona", "yan", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.checks.some((c: any) => String(c.name).includes("orphan"))).toBe(false);
    expect(d.verdict).not.toBe("fail");
  });

  test("多 persona 且不指定 → 逐个自检，不再整体 E_SCOPE fail", () => {
    // 上一条故意改坏了 AGENTS.md，先恢复，免得本用例被它带成 fail
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), ["---", "description: yan", "mode: primary", "---", "You are yan.", ""].join("\n"));
    const src2 = mkdtempSync(join(tmpdir(), "dia-act-src2-"));
    mkdirSync(join(src2, "agents"), { recursive: true });
    writeFileSync(join(src2, "agents", "dabo.md"), "---\ndescription: dabo\n---\nYou are dabo.\n");
    writeFileSync(join(src2, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "dabo", version: "0.1.0", hosts: ["opencode"], entry: { opencode: "agents/dabo.md" },
    }));
    expect(run(["persona", "add", "--from", src2]).status).toBe(0);

    const r = run(["doctor", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.personas.sort()).toEqual(["dabo", "yan"]);
    expect(d.checks.some((c: any) => c.name === "scope")).toBe(false);
    expect(d.checks.some((c: any) => c.name === "yan.persona")).toBe(true);
    expect(d.checks.some((c: any) => c.name === "dabo.persona")).toBe(true);
    expect(d.checks.filter((c: any) => c.name === "default_agent").length).toBe(1);
    expect(r.status).toBeLessThanOrEqual(1);

    run(["persona", "remove", "dabo"]);
  });
});

describe("persona check / update", () => {
  beforeAll(() => {
    // 前一个 describe 故意改坏了 AGENTS.md，这里恢复（重建 persona 树里的原件）
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), ["---", "description: yan", "mode: primary", "---", "You are yan.", ""].join("\n"));
  });

  test("本地目录安装 → relation=local-only", () => {
    const r = run(["persona", "check", "yan", "--json"]);
    const d = JSON.parse(r.stdout);
    expect(d.relation).toBe("local-only");
    expect(d.verify_ok).toBe(true);
    expect(r.status).toBe(0);
  });

  test("本地目录安装 → update 从记录的本地源重装（不报错）", () => {
    const r = run(["persona", "update", "yan", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).installed.id).toBe("yan");
  });

  test("内容被改 → check 返回 2", () => {
    writeFileSync(join(home, ".config/opencode/AGENTS.md"), "tampered\n");
    expect(run(["persona", "check", "yan"]).status).toBe(2);
  });
});

// 知识索引新鲜度：三态（目录缺失 fail / 索引缺失或落后 warn / 一致 ok），warn 不改退出码语义（1）
describe("dia doctor: 知识索引新鲜度", () => {
  let ksrc: string, kroot: string;
  const kcheck = (d: any, name = "knowledge") => d.checks.find((c: any) => c.name === name);

  beforeAll(() => {
    // 知识根刻意放在 persona 树外：改它不会动到 persona 内容哈希，才能把 verdict 稳定停在 warn
    kroot = mkdtempSync(join(tmpdir(), "dia-act-kbroot-"));
    mkdirSync(join(kroot, "rules"), { recursive: true });
    writeFileSync(join(kroot, "index.md"), "# Index\n\n- [R1](rules/r1.md)\n");
    writeFileSync(join(kroot, "rules", "r1.md"), "# R1\n\n规则一。\n");
    ksrc = mkdtempSync(join(tmpdir(), "dia-act-kbsrc-"));
    mkdirSync(join(ksrc, "agents"), { recursive: true });
    writeFileSync(join(ksrc, "agents", "kbby.md"), "---\ndescription: kbby\n---\nYou are kbby.\n");
    writeFileSync(join(ksrc, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "kbby", version: "0.1.0", hosts: ["opencode"],
      entry: { opencode: "agents/kbby.md" }, knowledge: [kroot],
    }));
    expect(run(["persona", "add", "--from", ksrc]).status).toBe(0);
  });

  test("persona add 后索引自动就绪 → ok（派生物不需要人手动建）", () => {
    const r = run(["doctor", "--persona", "kbby", "--json"]);
    const k = kcheck(JSON.parse(r.stdout));
    expect(k.status).toBe("ok");
    expect(k.detail).toContain(kroot);
  });

  test("索引被删 → warn，且文案说明会自动建（不是让人手跑）", () => {
    // 子进程用的是 data/cache，测试进程 env 不同 → 直接按目录清，别跨环境比 DB 路径
    const dir = join(data, "cache"); // DIA_CACHE_DIR=<data>/cache，DB 直接落在这一层
    for (const f of readdirSync(dir)) if (f.endsWith(".db")) rmSync(join(dir, f), { force: true });
    const r = run(["doctor", "--persona", "kbby", "--json"]);
    const k = kcheck(JSON.parse(r.stdout));
    expect(k.status).toBe("warn");
    expect(k.detail).toMatch(/自动建/);
    expect(r.status).toBe(1);
  });

  test("建索引后 → knowledge ok", () => {
    expect(run(["kb", "index", "--persona", "kbby"]).status).toBe(0);
    const r = run(["doctor", "--persona", "kbby", "--json"]);
    const k = kcheck(JSON.parse(r.stdout));
    expect(k.status).toBe("ok");
    expect(k.detail).toContain(kroot);
    expect(k.detail).not.toContain("重建");
  });

  test("知识新增一篇 → warn，detail 写落后篇数 + 可执行的重建命令，退出码 1", () => {
    writeFileSync(join(kroot, "rules", "r2.md"), "# R2\n\n规则二。\n");
    const r = run(["doctor", "--persona", "kbby", "--json"]);
    const k = kcheck(JSON.parse(r.stdout));
    expect(k.status).toBe("warn");
    expect(k.detail).toContain("落后 1 篇");
    expect(k.detail).toContain("新增 1");
    expect(k.detail).toContain("dia kb index --persona kbby");
    expect(r.status).toBe(1);
  });

  test("按 detail 里的命令重建 → 恢复 ok", () => {
    expect(run(["kb", "index", "--persona", "kbby"]).status).toBe(0);
    const r = run(["doctor", "--persona", "kbby", "--json"]);
    expect(kcheck(JSON.parse(r.stdout)).status).toBe("ok");
  });

  test("改内容（同一秒、大小不变）也判落后", () => {
    const f = join(kroot, "rules", "r1.md");
    writeFileSync(f, "# R1\n\n规则九。\n"); // 等长替换，mtime 秒内可能不变 → 靠聚合指纹兜底
    const r = run(["doctor", "--persona", "kbby", "--json"]);
    const k = kcheck(JSON.parse(r.stdout));
    expect(k.status).toBe("warn");
    expect(k.detail).toContain("dia kb index --persona kbby");
    expect(r.status).toBe(1);
    expect(run(["kb", "index", "--persona", "kbby"]).status).toBe(0);
  });

  test("索引属于其它知识根（foreign）→ warn，不判 fail", () => {
    // 把索引槽位让给另一个知识根：doctor 必须识别「索引不是我的」而不是当成最新
    const other = mkdtempSync(join(tmpdir(), "dia-act-kbother-"));
    writeFileSync(join(other, "x.md"), "# X\n");
    const slot = JSON.parse(run(["kb", "index", "--persona", "kbby", "--json"]).stdout).db;
    try {
      expect(run(["kb", "index", "--root", other, "--db", slot]).status).toBe(0);
      const r = run(["doctor", "--persona", "kbby", "--json"]);
      const d = JSON.parse(r.stdout);
      const k = kcheck(d);
      expect(k.status).toBe("warn");
      expect(k.detail).toContain("其它知识根");
      expect(k.detail).toContain("dia kb index --persona kbby");
      expect(d.verdict).not.toBe("fail");
      expect(r.status).toBeLessThanOrEqual(1);
    } finally {
      expect(run(["kb", "index", "--persona", "kbby"]).status).toBe(0);
    }
    expect(kcheck(JSON.parse(run(["doctor", "--persona", "kbby", "--json"]).stdout)).status).toBe("ok");
  });

  test("多 persona 共享同一知识根 → 各报一条，但不重复计算", () => {
    const src2 = mkdtempSync(join(tmpdir(), "dia-act-kbsrc2-"));
    mkdirSync(join(src2, "agents"), { recursive: true });
    writeFileSync(join(src2, "agents", "kbby2.md"), "---\ndescription: kbby2\n---\nYou are kbby2.\n");
    writeFileSync(join(src2, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "kbby2", version: "0.1.0", hosts: ["opencode"],
      entry: { opencode: "agents/kbby2.md" }, knowledge: [kroot],
    }));
    expect(run(["persona", "add", "--from", src2]).status).toBe(0);
    writeFileSync(join(kroot, "rules", "r3.md"), "# R3\n\n规则三。\n"); // 造一次落后
    try {
      const r = run(["doctor", "--json"]);
      const rows = JSON.parse(r.stdout).checks.filter((c: any) => c.name === "kbby.knowledge" || c.name === "kbby2.knowledge");
      expect(rows.length).toBe(2);
      expect(rows.every((c: any) => c.status === "warn")).toBe(true);
      expect(rows.filter((c: any) => c.detail.includes("共享知识根")).length).toBe(1);
    } finally {
      run(["persona", "remove", "kbby2"]);
      run(["kb", "index", "--persona", "kbby"]);
    }
  });
});

describe("dia doctor: 知识根目录缺失 / 重建命令转义", () => {
  test("persona 声明了知识根但目录不存在 → fail（真问题，不降级为 warn）", () => {
    const gone = join(mkdtempSync(join(tmpdir(), "dia-act-kbgone-")), "not-created");
    const src3 = mkdtempSync(join(tmpdir(), "dia-act-kbsrc3-"));
    mkdirSync(join(src3, "agents"), { recursive: true });
    writeFileSync(join(src3, "agents", "kbfail.md"), "---\ndescription: kbfail\n---\nYou are kbfail.\n");
    writeFileSync(join(src3, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "kbfail", version: "0.1.0", hosts: ["opencode"],
      entry: { opencode: "agents/kbfail.md" }, knowledge: [gone],
    }));
    expect(run(["persona", "add", "--from", src3]).status).toBe(0);
    try {
      const r = run(["doctor", "--persona", "kbfail", "--json"]);
      const d = JSON.parse(r.stdout);
      const k = d.checks.find((c: any) => c.name === "knowledge");
      expect(k.status).toBe("fail");
      expect(k.detail).toBe(gone);
      expect(d.verdict).toBe("fail");
      expect(r.status).toBe(2);
    } finally {
      run(["persona", "remove", "kbfail"]);
    }
  });

  test("detail 里的重建命令按 shell 规则转义（含空格 / 引号也能复制执行）", () => {
    expect(quoteArg("yan")).toBe("yan");
    expect(quoteArg("a-b_c.d")).toBe("a-b_c.d");
    expect(quoteArg("a b")).toBe("'a b'");
    expect(quoteArg("it's")).toBe("'it'\\''s'");
    expect(quoteArg("a;b")).toBe("'a;b'");
  });
});
