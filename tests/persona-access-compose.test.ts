import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// persona 数据根授权合成（docs/persona-install.md §5.5）
// 用「yaml 解析渲染后的 frontmatter」做精确断言：规则顺序即安全语义，不能靠 grep。
// 环境中没有 yaml 包（离线），用 bun 内置的 Bun.YAML.parse。

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

let data: string, home: string, work: string;

const env = () => ({
  ...process.env,
  DIA_ROOT: data,
  DIA_HOME: home,
  DIA_CACHE_DIR: join(data, "cache"),
  DIA_OPENCODE_AGENTS_DIR: join(data, "agents-out"),
  DIA_DSH_PROFILES_DIR: join(data, "dsh-profiles"),
  // 显式清掉外部注入，避免别处测试/宿主环境把 codex home 钉死
  DIA_CODEX_HOME: "",
});

const run = (args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env: env() });
const agentDest = (id: string) => join(data, "agents-out", `${id}.md`);

/** 取 frontmatter 并用 YAML 解析 */
function fm(text: string): any {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error("no frontmatter");
  return Bun.YAML.parse(m[1]);
}

interface PersonaSpec {
  id: string;
  access?: any;
  dataRoot?: string;
  body?: string;
  manifestExtra?: Record<string, unknown>;
  hosts?: string[];
}

/** 造一个最小 opencode persona，返回目录 */
function makePersona(spec: PersonaSpec, dir = mkdtempSync(join(tmpdir(), `dia-pa-${spec.id}-`))): string {
  mkdirSync(join(dir, "agents"), { recursive: true });
  const manifest: any = {
    schema: 1, kind: "persona", id: spec.id, version: "0.1.0",
    hosts: spec.hosts ?? ["opencode"],
    entry: { opencode: `agents/${spec.id}.md` },
    ...(spec.manifestExtra ?? {}),
  };
  if (spec.dataRoot !== undefined) manifest.data_root = spec.dataRoot;
  if (spec.access !== undefined) manifest.access = spec.access;
  writeFileSync(join(dir, "dia.json"), JSON.stringify(manifest));
  writeFileSync(
    join(dir, "agents", `${spec.id}.md`),
    spec.body ?? `---\ndescription: ${spec.id}\nmode: primary\n---\nYou are ${spec.id}.\n`,
  );
  return dir;
}

const root = (id: string) => join(home, `.${id}-agent`);

beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "dia-pa-data-"));
  home = mkdtempSync(join(tmpdir(), "dia-pa-home-"));
  work = mkdtempSync(join(tmpdir(), "dia-pa-work-"));
  for (const f of [join(data, "agents-out"), join(data, "cache")]) mkdirSync(f, { recursive: true });
});

beforeEach(() => {
  rmSync(join(data, "agents-out"), { recursive: true, force: true });
  mkdirSync(join(data, "agents-out"), { recursive: true });
});

describe("① 无 access：零回归", () => {
  test("install 产物 sha256 == 源 entry 字节", () => {
    const dir = makePersona({ id: "plain" });
    const r = run(["persona", "add", "plain", "--from", dir]);
    expect(r.status).toBe(0);
    expect(sha(agentDest("plain"))).toBe(sha(join(dir, "agents", "plain.md")));
  });

  test("render 产物 sha256 == 源 entry 字节", () => {
    const dir = makePersona({ id: "plain2" });
    expect(run(["persona", "add", "plain2", "--from", dir]).status).toBe(0);
    expect(run(["persona", "render", "plain2"]).status).toBe(0);
    expect(sha(agentDest("plain2"))).toBe(sha(join(dir, "agents", "plain2.md")));
  });
});

describe("② 有 access：合成规则与顺序精确", () => {
  test("追加到现有 permissions 尾部，顺序固定，保留后续顶层键", () => {
    const body = [
      "---",
      "description: acc",
      "mode: primary",
      "permissions:",
      '  - action: "*"',
      '    resource: "*"',
      "    effect: ask",
      "browser: deny",
      "---",
      "You are acc.",
      "",
    ].join("\n");
    const dir = makePersona({
      id: "acc",
      dataRoot: "~/.acc-agent",
      access: { read: true, write: true, env: false },
      body,
    });
    const r = run(["persona", "add", "acc", "--from", dir]);
    expect(r.status).toBe(0);
    const y = fm(readFileSync(agentDest("acc"), "utf8"));
    const R = root("acc");
    expect(y.browser).toBe("deny");
    expect(y.permissions).toEqual([
      { action: "*", resource: "*", effect: "ask" },
      { action: "external_directory", resource: `${R}/**`, effect: "allow" },
      { action: "read", resource: `${R}/**`, effect: "allow" },
      { action: "edit", resource: `${R}/**`, effect: "allow" },
      { action: "read", resource: `${R}/*.env`, effect: "ask" },
      { action: "read", resource: `${R}/*.env.*`, effect: "ask" },
    ]);
  });

  test("没有 permissions 键 → 新增 permissions 块", () => {
    const dir = makePersona({ id: "noperm", dataRoot: "~/.noperm-agent", access: { write: true } });
    expect(run(["persona", "add", "noperm", "--from", dir]).status).toBe(0);
    const y = fm(readFileSync(agentDest("noperm"), "utf8"));
    const R = root("noperm");
    expect(y.description).toBe("noperm");
    expect(y.permissions).toEqual([
      { action: "external_directory", resource: `${R}/**`, effect: "allow" },
      { action: "edit", resource: `${R}/**`, effect: "allow" },
    ]);
  });

  test("permissions: [] 视为空列表并写入规则", () => {
    const body = "---\ndescription: empty\npermissions: []\n---\nbody\n";
    const dir = makePersona({ id: "emptyperm", dataRoot: "~/.emptyperm-agent", access: { read: true }, body });
    expect(run(["persona", "add", "emptyperm", "--from", dir]).status).toBe(0);
    const y = fm(readFileSync(agentDest("emptyperm"), "utf8"));
    const R = root("emptyperm");
    expect(y.permissions).toEqual([
      { action: "external_directory", resource: `${R}/**`, effect: "allow" },
      { action: "read", resource: `${R}/**`, effect: "allow" },
      { action: "edit", resource: `${R}/**`, effect: "deny" },
      { action: "read", resource: `${R}/*.env`, effect: "ask" },
      { action: "read", resource: `${R}/*.env.*`, effect: "ask" },
    ]);
  });
});

describe("③ 幂等", () => {
  test("连续 render 两次：第二次 drift=0、字节不变", () => {
    const dir = makePersona({ id: "idem", dataRoot: "~/.idem-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "idem", "--from", dir]).status).toBe(0);
    const before = readFileSync(agentDest("idem"), "utf8");
    expect(run(["persona", "render", "idem"]).status).toBe(0);
    expect(readFileSync(agentDest("idem"), "utf8")).toBe(before);
    const chk = run(["persona", "render", "idem", "--check"]);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain("无 drift");
    expect(readFileSync(agentDest("idem"), "utf8")).toBe(before);
  });
});

describe("④ 去重", () => {
  test("源里已手写同键 allow → 期望==源、无新增", () => {
    const R = root("dupe");
    const body = [
      "---",
      "description: dupe",
      "permissions:",
      `  - action: external_directory`,
      `    resource: ${R}/**`,
      `    effect: allow`,
      `  - action: read`,
      `    resource: ${R}/**`,
      `    effect: allow`,
      `  - action: edit`,
      `    resource: ${R}/**`,
      `    effect: allow`,
      "---",
      "You are dupe.",
      "",
    ].join("\n");
    const dir = makePersona({ id: "dupe", dataRoot: "~/.dupe-agent", access: { read: true, write: true, env: true }, body });
    expect(run(["persona", "add", "dupe", "--from", dir]).status).toBe(0);
    expect(readFileSync(agentDest("dupe"), "utf8")).toBe(body);
  });

  test("~ 与 $HOME 归一化后也算同键", () => {
    const body = [
      "---",
      "description: tilde",
      "permissions:",
      "  - action: read",
      "    resource: ~/.tilde-agent/**",
      "    effect: allow",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id: "tilde", dataRoot: "~/.tilde-agent", access: { read: true }, body });
    expect(run(["persona", "add", "tilde", "--from", dir]).status).toBe(0);
    const y = fm(readFileSync(agentDest("tilde"), "utf8"));
    const reads = (y.permissions as any[]).filter((p) => p.action === "read" && p.effect === "allow");
    expect(reads.length).toBe(1); // 不重复追加（~ 归一化后与合成期望同键）
  });
});

describe("⑤⑥ 冲突 fail closed", () => {
  test("同 (action, resource) 不同 effect → 32 + 行号提示", () => {
    const R = root("conflict");
    const body = [
      "---",
      "description: conflict",
      "permissions:",
      "  - action: read",
      `    resource: ${R}/**`,
      "    effect: deny",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id: "conflict", dataRoot: "~/.conflict-agent", access: { read: true }, body });
    const r = run(["persona", "add", "conflict", "--from", dir]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_MANIFEST");
    expect(r.stderr).toMatch(/第 \d+ 行/);
    expect(existsSync(agentDest("conflict"))).toBe(false);
  });

  test("更宽的 deny（edit * deny）→ 32", () => {
    const body = [
      "---",
      "description: wide",
      "permissions:",
      "  - action: edit",
      '    resource: "*"',
      "    effect: deny",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id: "wide", dataRoot: "~/.wide-agent", access: { write: true }, body });
    const r = run(["persona", "add", "wide", "--from", dir]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_MANIFEST");
    expect(existsSync(agentDest("wide"))).toBe(false);
  });

  test("祖先 glob deny（edit ~/* deny）覆盖 root → 32", () => {
    const body = [
      "---",
      "description: anc",
      "permissions:",
      "  - action: edit",
      "    resource: ~/*",
      "    effect: deny",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id: "anc", dataRoot: "~/.anc-agent", access: { write: true }, body });
    const r = run(["persona", "add", "anc", "--from", dir]);
    expect(r.status).toBe(32);
  });
});

describe("⑦ 畸形 data_root 矩阵", () => {
  const SENTINEL = "SENTINEL-UNTOUCHED\n";
  const cases: { id: string; dataRoot?: string; access?: any; setup?: () => void }[] = [
    { id: "m-noroot", access: { read: true } }, // access 存在但 data_root 缺失
    { id: "m-rel", dataRoot: "repos/dabo-agent", access: { read: true } }, // 相对路径
    { id: "m-user", dataRoot: "~u/x", access: { read: true } }, // ~user 形式
    { id: "m-tilde", dataRoot: "~", access: { read: true } }, // 家目录本身
    { id: "m-nested", dataRoot: "~/repos/x", access: { read: true } }, // 不在家目录直下
    { id: "m-dotdot", dataRoot: "~/.m-dotdot-agent/../.m-dotdot-agent", access: { read: true } },
    { id: "m-glob", dataRoot: "~/.m-glob-*", access: { read: true } },
    {
      id: "m-symlink",
      dataRoot: "~/.m-symlink-agent",
      access: { read: true },
      setup: () => {
        const outside = mkdtempSync(join(tmpdir(), "dia-pa-outside-"));
        symlinkSync(outside, join(home, ".m-symlink-agent"), "dir");
      },
    },
  ];

  for (const c of cases) {
    test(`${c.id}: 非零退出 + dest 字节未变`, () => {
      c.setup?.();
      const dir = makePersona({ id: c.id, dataRoot: c.dataRoot, access: c.access });
      const dest = agentDest(c.id);
      writeFileSync(dest, SENTINEL);
      const r = run(["persona", "add", c.id, "--from", dir]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("E_MANIFEST");
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe(SENTINEL);
    });
  }
});

describe("⑧ 结构异常", () => {
  const bodies: Record<string, string> = {
    "s-nofm": "You are nobody.\n",
    "s-flow": "---\ndescription: flow\npermissions: [{action: read, resource: x, effect: allow}]\n---\nbody\n",
    "s-v1": "---\ndescription: v1\npermissions:\n  read: allow\n  edit: deny\n---\nbody\n",
    "s-tab": "---\ndescription: tab\npermissions:\n\t- action: read\n\t  resource: x\n\t  effect: allow\n---\nbody\n",
    "s-mapitem": "---\ndescription: scalar\npermissions:\n  - read\n---\nbody\n",
  };
  for (const [id, body] of Object.entries(bodies)) {
    test(`${id}: 退出 32`, () => {
      const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
      const r = run(["persona", "add", id, "--from", dir]);
      expect(r.status).toBe(32);
      expect(r.stderr).toContain("E_MANIFEST");
      expect(existsSync(agentDest(id))).toBe(false);
    });
  }
});

describe("⑨⑩⑪ env / write / 类型", () => {
  test("env 缺省（false）→ 两条 .env ask，且排在 read allow 之后", () => {
    const dir = makePersona({ id: "envoff", dataRoot: "~/.envoff-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "envoff", "--from", dir]).status).toBe(0);
    const perms = fm(readFileSync(agentDest("envoff"), "utf8")).permissions as any[];
    const R = root("envoff");
    const readAllow = perms.findIndex((p) => p.action === "read" && p.resource === `${R}/**` && p.effect === "allow");
    expect(readAllow).toBeGreaterThanOrEqual(0);
    const asks = perms
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.action === "read" && p.effect === "ask");
    expect(asks.map(({ p }) => p.resource)).toEqual([`${R}/*.env`, `${R}/*.env.*`]);
    // 两条 ask 必须排在 read allow 之后（否则后写的 allow 会覆盖它们）
    for (const { i } of asks) expect(i).toBeGreaterThan(readAllow);
  });

  test("env=true → 没有 .env ask", () => {
    const dir = makePersona({ id: "envon", dataRoot: "~/.envon-agent", access: { read: true, write: true, env: true } });
    expect(run(["persona", "add", "envon", "--from", dir]).status).toBe(0);
    const perms = fm(readFileSync(agentDest("envon"), "utf8")).permissions as any[];
    expect(perms.some((p) => p.effect === "ask")).toBe(false);
  });

  test("write=false → edit <root>/** deny；write=true → allow", () => {
    const off = makePersona({ id: "woff", dataRoot: "~/.woff-agent", access: { read: true, write: false } });
    expect(run(["persona", "add", "woff", "--from", off]).status).toBe(0);
    const on = makePersona({ id: "won", dataRoot: "~/.won-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "won", "--from", on]).status).toBe(0);
    const R1 = root("woff"), R2 = root("won");
    const p1 = (fm(readFileSync(agentDest("woff"), "utf8")).permissions as any[]).find((p) => p.action === "edit");
    const p2 = (fm(readFileSync(agentDest("won"), "utf8")).permissions as any[]).find((p) => p.action === "edit");
    expect(p1).toEqual({ action: "edit", resource: `${R1}/**`, effect: "deny" });
    expect(p2).toEqual({ action: "edit", resource: `${R2}/**`, effect: "allow" });
  });

  test("write=true 但 read!=true → 输出 warn", () => {
    const dir = makePersona({ id: "wonly", dataRoot: "~/.wonly-agent", access: { write: true } });
    const r = run(["persona", "add", "wonly", "--from", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("read!=true");
  });

  test("dsh/codex host 声明 access → warn 本期不生效", () => {
    const dir = makePersona({ id: "codexacc", dataRoot: "~/.codexacc-agent", access: { read: true }, hosts: ["codex"] });
    // codex 需 entry.codex
    const m = JSON.parse(readFileSync(join(dir, "dia.json"), "utf8"));
    m.entry = { codex: "AGENTS.md" };
    writeFileSync(join(dir, "dia.json"), JSON.stringify(m));
    writeFileSync(join(dir, "AGENTS.md"), "# codexacc\n");
    const r = run(["persona", "add", "codexacc", "--from", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("access 对 host=codex 本期不生效");
  });

  test("root 尚不存在 → warn", () => {
    const dir = makePersona({ id: "norootdir", dataRoot: "~/.norootdir-agent", access: { read: true } });
    const r = run(["persona", "add", "norootdir", "--from", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("尚不存在");
  });

  test('access.read 写成字符串 "false" → 退出 32', () => {
    const dir = makePersona({ id: "strac", dataRoot: "~/.strac-agent", access: { read: "false" } });
    const r = run(["persona", "add", "strac", "--from", dir]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_MANIFEST");
  });
});

describe("纯函数 composeAgentText", () => {
  let accessMod: any;
  beforeAll(async () => {
    accessMod = await import("../src/persona-access.ts");
  });

  test("非法路径直接抛 E_MANIFEST", () => {
    expect(() => accessMod.composeAgentText("---\nx: 1\n---\n", {
      id: "dabo", dataRoot: "~/.ssh", access: { read: true }, homedir: home,
    })).toThrow(/E_MANIFEST/);
  });

  test("幂等：合成两次字节相同（对已合成文本再合成不叠加）", () => {
    const src = "---\ndescription: x\n---\nbody\n";
    const opts = { id: "dabo2", dataRoot: "~/.dabo2-agent", access: { read: true, write: true }, homedir: home };
    const once = accessMod.composeAgentText(src, opts);
    const twice = accessMod.composeAgentText(once.text, opts);
    expect(twice.text).toBe(once.text);
    expect(twice.added).toBe(0);
  });
});
