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

  test("dsh profile 缺文件：render 恢复", () => {
    setup();
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
