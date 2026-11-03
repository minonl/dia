import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let persona: any;
let data: string, agents: string, profiles: string, cache: string, work: string;

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "dia-cr-data-"));
  agents = mkdtempSync(join(tmpdir(), "dia-cr-agents-"));
  profiles = mkdtempSync(join(tmpdir(), "dia-cr-profiles-"));
  cache = mkdtempSync(join(tmpdir(), "dia-cr-cache-"));
  process.env.DIA_DATA_DIR = data;
  process.env.DIA_OPENCODE_AGENTS_DIR = agents;
  process.env.DIA_DSH_PROFILES_DIR = profiles;
  process.env.DIA_CACHE_DIR = cache;
  persona = await import("../src/persona.ts");
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "dia-cr-src-"));
});

describe("persona create", () => {
  test("生成骨架：dia.json + opencode agent + dsh profile 文件", () => {
    const r = persona.create("mybot", { dir: join(work, "mybot") });
    expect(existsSync(join(r.dir, "dia.json"))).toBe(true);
    expect(existsSync(join(r.dir, "agents", "mybot.md"))).toBe(true);
    expect(existsSync(join(r.dir, "platform/dsh/mybot-persona/cordis.patch.yml"))).toBe(true);
    const m = JSON.parse(readFileSync(join(r.dir, "dia.json"), "utf8"));
    expect(m.kind).toBe("persona");
    expect(m.entry.opencode).toBe("agents/mybot.md");
    // 骨架里必填 config 已经带上（踩过的坑）
    expect(readFileSync(join(r.dir, "platform/dsh/mybot-persona/cordis.patch.yml"), "utf8")).toContain("sampleOverCapGlobResults");
  });

  test("dry-run 不写盘", () => {
    const dir = join(work, "dry");
    const r = persona.create("dry", { dir, dryRun: true });
    expect(r.files.length).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("非空目录 → E_CONFLICT；坏 id → E_MANIFEST", () => {
    const dir = join(work, "busy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x");
    expect(() => persona.create("busy", { dir })).toThrow(/E_CONFLICT/);
    expect(() => persona.create("Bad_ID", { dir: join(work, "x") })).toThrow(/E_MANIFEST/);
  });

  test("create 的骨架能直接 add 并 verify", () => {
    const src = join(work, "gen");
    persona.create("gen", { dir: src });
    const r = persona.install(src);
    expect(r.id).toBe("gen");
    expect(persona.verify("gen").ok).toBe(true);
    expect(existsSync(join(agents, "gen.md"))).toBe(true);
    expect(existsSync(join(profiles, "gen", ".dia-managed"))).toBe(true);
    persona.remove("gen");
  });
});

describe("persona render", () => {
  const setup = () => {
    const src = join(work, "r");
    persona.create("rbot", { dir: src });
    persona.install(src);
    return src;
  };

  test("健康态：--check 无 drift", () => {
    setup();
    const r = persona.render("rbot", { check: true });
    expect(r.drift).toEqual([]);
    persona.remove("rbot");
  });

  test("产物被删：check 报 missing，render 修复且 verify 通过", () => {
    setup();
    const agent = join(agents, "rbot.md");
    rmSync(agent);
    const chk = persona.render("rbot", { check: true });
    expect(chk.drift.some((d: any) => d.path === agent && d.action === "missing")).toBe(true);
    expect(existsSync(agent)).toBe(false); // check 不写盘
    persona.render("rbot");
    expect(existsSync(agent)).toBe(true);
    expect(persona.verify("rbot").ok).toBe(true);
    persona.remove("rbot");
  });

  test("产物被手改：render 先备份再写回", () => {
    setup();
    const agent = join(agents, "rbot.md");
    writeFileSync(agent, "user edited\n");
    const r = persona.render("rbot");
    expect(r.backups.length).toBe(1);
    expect(readFileSync(r.backups[0], "utf8")).toBe("user edited\n");
    expect(readFileSync(agent, "utf8")).toContain("你是 **rbot**");
    persona.remove("rbot");
  });

  test("宿主改写 cordis.yml 不算 drift（dsh 运行时自写）", () => {
    setup();
    const prof = join(profiles, "rbot");
    writeFileSync(join(prof, "cordis.yml"), "[]\n");
    expect(persona.render("rbot", { check: true }).drift).toEqual([]);
    persona.remove("rbot");
  });

  test("dsh profile 缺文件：render 恢复", () => {    setup();
    const prof = join(profiles, "rbot");
    const before = readdirSync(prof).length;
    rmSync(join(prof, "cordis.patch.yml"));
    expect(persona.render("rbot", { check: true }).drift.length).toBeGreaterThan(0);
    persona.render("rbot");
    expect(readdirSync(prof).length).toBe(before);
    expect(persona.verify("rbot").ok).toBe(true);
    persona.remove("rbot");
  });
});

describe("renderDrift（doctor 用的只读查询）", () => {
  const setup = () => {
    const src = join(work, "rd");
    persona.create("rdbot", { dir: src });
    persona.install(src);
  };

  test("健康态：drift 为空", () => {
    setup();
    expect(persona.renderDrift("rdbot").drift).toEqual([]);
    persona.remove("rdbot");
  });

  test("产物被手改 / 删除 → changed / missing，且不写盘、不改 dia.lock", () => {
    setup();
    const agent = join(agents, "rdbot.md");
    const lockPath = join(data, "personas", "rdbot", "0.1.0", "dia.lock");
    const lockBefore = readFileSync(lockPath, "utf8");

    writeFileSync(agent, "user edited\n");
    const rep = persona.renderDrift("rdbot");
    expect(rep.drift.some((d: any) => d.path === agent && d.action === "changed")).toBe(true);
    expect(readFileSync(agent, "utf8")).toBe("user edited\n"); // 只读：不修复
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore); // 只读：不改 lock
    expect(persona.verify("rdbot").ok).toBe(false); // verify 视角也是红的（语义不冲突）

    rmSync(agent);
    expect(persona.renderDrift("rdbot").drift.some((d: any) => d.path === agent && d.action === "missing")).toBe(true);
    persona.remove("rdbot");
  });

  test("persona 自带 files 渲染到宿主的产物被改 → drifted（如 AGENTS.md）", () => {
    const src = join(work, "rdf");
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "rdfile.md"), "---\ndescription: rdfile\n---\nYou are rdfile.\n");
    writeFileSync(join(src, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: "rdfile", version: "0.1.0", hosts: ["opencode"],
      entry: { opencode: "agents/rdfile.md" },
      files: [{ from: "agents/rdfile.md", to: "~/.config/opencode/AGENTS.md" }],
    }));
    // `files.to` 走 DIA_HOME 展开：必须指到临时 HOME，别落到真实家目录
    const prevHome = process.env.DIA_HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "dia-cr-home-"));
    process.env.DIA_HOME = fakeHome;
    try {
      expect(persona.install(src).id).toBe("rdfile");
      const dest = join(fakeHome, ".config/opencode/AGENTS.md");
      expect(persona.renderDrift("rdfile").drift).toEqual([]);
      writeFileSync(dest, "tampered\n");
      const rep = persona.renderDrift("rdfile");
      expect(rep.drift.some((d: any) => d.path === dest && d.action === "changed")).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe("tampered\n"); // 只读：不修复
    } finally {
      if (prevHome === undefined) delete process.env.DIA_HOME;
      else process.env.DIA_HOME = prevHome;
      persona.remove("rdfile");
    }
  });

  test("未安装 → E_NOT_INSTALLED（doctor 侧降级为 skip）", () => {
    expect(() => persona.renderDrift("ghost")).toThrow(/E_NOT_INSTALLED/);
  });

  test("宿主改写 profile 里的 package.json / 自带插件 → 不算 drift，render 也不回退/删除", () => {
    const src = join(work, "rdhost");
    persona.create("rdhost", { dir: src });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "rdhost" }) + "\n");
    persona.install(src);
    const prof = join(profiles, "rdhost");
    // 模拟宿主：`dsh plugin --profile rdhost add plug` 改 package.json 并装插件
    writeFileSync(join(prof, "package.json"), JSON.stringify({ name: "rdhost", dependencies: { plug: "1" } }) + "\n");
    mkdirSync(join(prof, "plugins"), { recursive: true });
    writeFileSync(join(prof, "plugins", "host-installed.js"), "host\n");

    expect(persona.verify("rdhost").ok).toBe(true);
    expect(persona.renderDrift("rdhost").drift).toEqual([]);

    persona.render("rdhost");
    expect(existsSync(join(prof, "plugins", "host-installed.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(prof, "package.json"), "utf8")).dependencies).toEqual({ plug: "1" });
    persona.remove("rdhost");
  });
});

describe("render 安全边界", () => {
  test("安装目录被手改成越界 entry → E_MANIFEST，不复制目录外文件", () => {
    const src = join(work, "evil");
    persona.create("evil", { dir: src });
    persona.install(src);
    const lockDir = join(data, "personas", "evil", "0.1.0");
    const m = JSON.parse(readFileSync(join(lockDir, "dia.json"), "utf8"));
    m.entry.opencode = "../../outside.md";
    writeFileSync(join(lockDir, "dia.json"), JSON.stringify(m));
    expect(() => persona.render("evil")).toThrow(/escapes persona dir/);
    persona.remove("evil");
  });
});
