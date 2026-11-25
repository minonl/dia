import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

// persona 数据根授权合成（docs/persona-install.md §5.5）
// 合成走 yaml 包的 Document round-trip；断言也用 yaml 解析渲染产物——
// 规则顺序即安全语义，不能靠 grep。

const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

let data: string, home: string, work: string;

const env = (over: Record<string, string | undefined> = {}) => ({
  ...process.env,
  DIA_ROOT: data,
  DIA_HOME: home,
  DIA_CACHE_DIR: join(data, "cache"),
  DIA_OPENCODE_AGENTS_DIR: join(data, "agents-out"),
  DIA_DSH_PROFILES_DIR: join(data, "dsh-profiles"),
  // 显式清掉外部注入，避免别处测试/宿主环境把 codex home 钉死
  DIA_CODEX_HOME: "",
  ...over,
});

const run = (args: string[], over: Record<string, string | undefined> = {}) =>
  spawnSync("bun", [cli, ...args], { encoding: "utf8", env: env(over) });
const agentDest = (id: string) => join(data, "agents-out", `${id}.md`);

/** 取 frontmatter 文本（收尾只认列 0 的 `---`，块标量里的 `---` 有缩进） */
function fmText(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("no frontmatter");
  const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (end < 0) throw new Error("no closing ---");
  return lines.slice(1, end).join("\n");
}
const fm = (text: string): any => parseYaml(fmText(text));

const rule = (action: string, resource: string, effect: string) => ({ action, resource, effect });
const has = (perms: any[], r: { action: string; resource: string; effect: string }) =>
  perms.some((p) => p?.action === r.action && p?.resource === r.resource && p?.effect === r.effect);

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

/** fail closed 断言：退出码精确 32、报 E_MANIFEST、dest 不存在 */
function expectReject(r: { status: number | null; stderr: string }, id: string) {
  expect(r.status).toBe(32);
  expect(r.stderr).toContain("E_MANIFEST");
  expect(existsSync(agentDest(id))).toBe(false);
}

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

  test("行尾注释不影响去重（同键仍只留一条）", () => {
    const R = root("cdupe");
    const body = [
      "---",
      "description: cdupe",
      "permissions: # 键行注释",
      "  - action: read # 行尾",
      `    resource: ${R}/** # 行尾`,
      "    effect: allow # 行尾",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id: "cdupe", dataRoot: "~/.cdupe-agent", access: { read: true }, body });
    expect(run(["persona", "add", "cdupe", "--from", dir]).status).toBe(0);
    const y = fm(readFileSync(agentDest("cdupe"), "utf8"));
    const reads = (y.permissions as any[]).filter((p) => p.action === "read" && p.effect === "allow");
    expect(reads.length).toBe(1);
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

// 更宽 deny 的 5 种 glob 写法：合成 allow 会被静默覆盖 —— 必须全部 32
describe("⑤b 更宽 deny 的 glob 写法（全部 fail closed）", () => {
  const R5 = (id: string) => root(id);
  const cases: { id: string; resource: (r: string) => string }[] = [
    { id: "deny-ss", resource: () => "/**" },
    { id: "deny-s", resource: () => "/*" },
    { id: "deny-ds", resource: () => "**/*" },
    { id: "deny-brace", resource: (r) => `{${r},/var/tmp}/**` },
    { id: "deny-q", resource: () => join(home, ".?-agent/**") }, // `<home>/.?-agent/**` 命中 `.q-agent`
  ];
  for (const c of cases) {
    test(`${c.id}: 更宽 deny → 32`, () => {
      // deny-q 需要 root 形如 ~/.q?-agent（id=q）；其它写法与 id 无关
      const id = c.id === "deny-q" ? "q" : c.id;
      const r = R5(id);
      const body = [
        "---",
        "description: denyglob",
        "permissions:",
        "  - action: edit",
        `    resource: ${JSON.stringify(c.resource(r))}`,
        "    effect: deny",
        "---",
        "body",
        "",
      ].join("\n");
      const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { write: true }, body });
      const res = run(["persona", "add", id, "--from", dir]);
      expectReject(res, id);
    });
  }
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
    test(`${c.id}: 退出 32 + dest 字节未变`, () => {
      c.setup?.();
      const dir = makePersona({ id: c.id, dataRoot: c.dataRoot, access: c.access });
      const dest = agentDest(c.id);
      writeFileSync(dest, SENTINEL);
      const r = run(["persona", "add", c.id, "--from", dir]);
      expect(r.status).toBe(32);
      expect(r.stderr).toContain("E_MANIFEST");
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe(SENTINEL);
    });
  }
});

describe("⑧ 结构异常（退出 32、不写盘）", () => {
  // 注：flow-style `permissions: [ … ]` 自 yaml round-trip 起重写后**合法**（见 ⑫ fixture）。
  const bodies: Record<string, string> = {
    "s-nofm": "You are nobody.\n",
    "s-v1": "---\ndescription: v1\npermissions:\n  read: allow\n  edit: deny\n---\nbody\n",
    "s-tab": "---\ndescription: tab\npermissions:\n\t- action: read\n\t  resource: x\n\t  effect: allow\n---\nbody\n",
    "s-mapitem": "---\ndescription: scalar\npermissions:\n  - read\n---\nbody\n",
    "s-badyaml": "---\ndescription: bad\npermissions: [unclosed\n---\nbody\n",
  };
  for (const [id, body] of Object.entries(bodies)) {
    test(`${id}: 退出 32`, () => {
      const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
      const r = run(["persona", "add", id, "--from", dir]);
      expectReject(r, id);
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

// ---- ⑫ 邪门但合法的 frontmatter：yaml round-trip 必须原样保留 -----------------
interface Fixture {
  id: string;
  body: string;
  access: any;
  /** 额外断言（dest 全文 + 解析后的 frontmatter + 合成根） */
  extra?: (dest: string, y: any, R: string) => void;
}

const FIXTURES: Fixture[] = [
  {
    id: "fm-block",
    body: [
      "---",
      "description: |",
      "  line one",
      "  ---",
      "  line two",
      "mode: primary",
      "---",
      "body",
      "",
    ].join("\n"),
    access: { read: true },
    extra: (_dest, y) => {
      // 块标量里的列 0 `---`（缩进后）不能被当收尾
      expect(y.description).toBe("line one\n---\nline two\n");
      expect(y.mode).toBe("primary");
    },
  },
  {
    id: "fm-quoted",
    body: [
      "---",
      "description: quoted",
      '"permissions":',
      '  - action: "*"',
      '    resource: "*"',
      "    effect: ask",
      "---",
      "body",
      "",
    ].join("\n"),
    access: { read: true },
    extra: (dest, y) => {
      expect(y.permissions[0]).toEqual(rule("*", "*", "ask"));
      // 带引号的键就是 permissions：不能重复映射键（重复 → 宿主丢弃整个 agent）
      expect((dest.match(/^\s*"?permissions"?\s*:/gm) ?? []).length).toBe(1);
    },
  },
  {
    id: "fm-c0-comment",
    body: [
      "---",
      "description: c0",
      "permissions:",
      "# 列 0 注释：不该截断 permissions 块",
      '  - action: "*"',
      '    resource: "*"',
      "    effect: ask",
      "browser: deny",
      "---",
      "body",
      "",
    ].join("\n"),
    access: { read: true },
    extra: (dest, y) => {
      expect(dest).toContain("列 0 注释");
      expect(y.browser).toBe("deny");
      expect(y.permissions[0]).toEqual(rule("*", "*", "ask"));
    },
  },
  {
    id: "fm-indent-comment",
    body: [
      "---",
      "description: ind",
      "permissions:",
      '  - action: "*"',
      '    resource: "*"',
      "    effect: ask",
      "    # 缩进注释",
      "  # 更浅的缩进注释",
      "---",
      "body",
      "",
    ].join("\n"),
    access: { read: true },
    extra: (dest, y) => {
      expect(dest).toContain("缩进注释");
      expect(dest).toContain("更浅的缩进注释");
      expect(y.permissions[0]).toEqual(rule("*", "*", "ask"));
    },
  },
  {
    id: "fm-inline-comment",
    body: [
      "---",
      "description: tail # 行尾注释",
      "permissions: # 键行带注释",
      '  - action: "*" # 行尾',
      '    resource: "*" # 行尾',
      "    effect: ask # 行尾",
      "---",
      "body",
      "",
    ].join("\n"),
    access: { read: true },
    extra: (dest, y) => {
      expect(y.description).toBe("tail");
      expect(dest).toContain("行尾注释");
      expect(dest).toContain("键行带注释");
      expect(y.permissions[0]).toEqual(rule("*", "*", "ask"));
    },
  },
  {
    id: "fm-flow-item",
    body: [
      "---",
      "description: flowitem",
      'permissions: [{action: read, resource: "~/.fm-flow-item-agent/**", effect: allow}]',
      "---",
      "body",
      "",
    ].join("\n"),
    access: { read: true, env: true },
    extra: (_dest, y, R) => {
      // flow 单行项合法；同键去重（read allow 已存在 → 只补 external_directory + edit deny）
      expect(y.permissions.filter((p: any) => p.action === "read" && p.effect === "allow").length).toBe(1);
      expect(has(y.permissions, rule("external_directory", `${R}/**`, "allow"))).toBe(true);
      expect(has(y.permissions, rule("edit", `${R}/**`, "deny"))).toBe(true);
    },
  },
  {
    id: "fm-top-flow",
    body: [
      "---",
      "description: topflow",
      "meta: {author: me, tags: [a, b]}",
      "permissions: []",
      "---",
      "body",
      "",
    ].join("\n"),
    access: { write: true },
    extra: (_dest, y) => {
      expect(y.meta).toEqual({ author: "me", tags: ["a", "b"] });
    },
  },
  {
    id: "fm-crlf",
    body: [
      "---",
      "description: crlf",
      "permissions:",
      '  - action: "*"',
      '    resource: "*"',
      "    effect: ask",
      "---",
      "body",
      "",
    ].join("\r\n"),
    access: { read: true },
    extra: (dest, y) => {
      // 全文件保持 CRLF，不能混进裸 LF
      expect(dest.startsWith("---\r\n")).toBe(true);
      expect(/(^|[^\r])\n/.test(dest)).toBe(false);
      expect(y.description).toBe("crlf");
    },
  },
];

describe("⑫ 邪门但合法的 frontmatter（yaml round-trip）", () => {
  const installed = new Map<string, string>();
  for (const f of FIXTURES) {
    test(`${f.id}: 合成成功且内容/注释保留`, () => {
      const dir = makePersona({ id: f.id, dataRoot: `~/.${f.id}-agent`, access: f.access, body: f.body });
      const r = run(["persona", "add", f.id, "--from", dir]);
      expect(r.status).toBe(0);
      const dest = readFileSync(agentDest(f.id), "utf8");
      installed.set(f.id, dest);
      const y = fm(dest);
      const R = root(f.id);
      expect(has(y.permissions, rule("external_directory", `${R}/**`, "allow"))).toBe(true);
      // 合成规则必须压在已有 `*: ask` 之后
      expect(y.permissions[y.permissions.length - 1].action).not.toBe("*");
      f.extra?.(dest, y, R);
    });
  }

  test("全部 fixture 再 render 一次：字节不变（round-trip 稳定）", () => {
    for (const f of FIXTURES) {
      expect(run(["persona", "render", f.id]).status).toBe(0);
      expect(readFileSync(agentDest(f.id), "utf8")).toBe(installed.get(f.id)!);
    }
  });
});

// ---- ⑬ verify 与 access ------------------------------------------------------
describe("⑬ verify / access 一致性", () => {
  test("装完 verify ok；产物被改 → 1 且报「产物被改动」", () => {
    const dir = makePersona({ id: "vfy", dataRoot: "~/.vfy-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "vfy", "--from", dir]).status).toBe(0);
    const ok = run(["persona", "verify", "vfy"]);
    expect(ok.status).toBe(0);
    writeFileSync(agentDest("vfy"), "---\ndescription: hacked\n---\n");
    const bad = run(["persona", "verify", "vfy"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain("产物被改动");
  });

  test("换 HOME 重跑 verify：仍 ok，不误报「与 lock 不一致」", () => {
    const dir = makePersona({ id: "vfyhome", dataRoot: "~/.vfyhome-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "vfyhome", "--from", dir]).status).toBe(0);
    const other = mkdtempSync(join(tmpdir(), "dia-pa-otherhome-"));
    const res = run(["persona", "verify", "vfyhome"], { DIA_HOME: other });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("与 lock 记录不一致");
  });

  test("data_root 首装后变成 symlink → verify 退出 32（E_MANIFEST）", () => {
    const dir = makePersona({ id: "vfyroot", dataRoot: "~/.vfyroot-agent", access: { read: true } });
    expect(run(["persona", "add", "vfyroot", "--from", dir]).status).toBe(0);
    const outside = mkdtempSync(join(tmpdir(), "dia-pa-vfyroot-outside-"));
    symlinkSync(outside, root("vfyroot"), "dir");
    const res = run(["persona", "verify", "vfyroot"]);
    expect(res.status).toBe(32);
    expect(res.stderr).toContain("E_MANIFEST");
  });

  test("verify 遇到坏 frontmatter → 32（不是 1）", () => {
    // 装完之后把已安装槽位的 entry 改成非法 YAML（模拟宿主侧/手改把合成基础弄坏）
    const dir = makePersona({ id: "vfybad", dataRoot: "~/.vfybad-agent", access: { read: true } });
    expect(run(["persona", "add", "vfybad", "--from", dir]).status).toBe(0);
    const slotDir = join(data, "personas", "vfybad");
    const slot = join(slotDir, readdirSync(slotDir)[0], "agents", "vfybad.md");
    writeFileSync(slot, "---\npermissions: [unclosed\n---\nbody\n");
    const res = run(["persona", "verify", "vfybad"]);
    expect(res.status).toBe(32);
    expect(res.stderr).toContain("E_MANIFEST");
  });

  test("persona use 不把 E_MANIFEST 降级成 warn（32，且切指针前失败）", () => {
    const dir = makePersona({ id: "usebad", dataRoot: "~/.usebad-agent", access: { read: true } });
    expect(run(["persona", "add", "usebad", "--from", dir]).status).toBe(0);
    const slotDir = join(data, "personas", "usebad");
    const slot = join(slotDir, readdirSync(slotDir)[0], "agents", "usebad.md");
    writeFileSync(slot, "---\npermissions: [unclosed\n---\nbody\n");
    const res = run(["persona", "use", "usebad"]);
    expect(res.status).toBe(32);
    expect(res.stderr).toContain("E_MANIFEST");
    const activeFile = join(data, "state", "active.json");
    if (existsSync(activeFile)) expect(readFileSync(activeFile, "utf8")).not.toContain("usebad");
  });
});

// ---- ⑭ CLI 输出：--check --json 的 access 计数 -------------------------------
describe("⑭ render --check --json 的 access 计数", () => {
  test("dest 缺失时 drift=1 且 access.added 非 0", () => {
    const dir = makePersona({ id: "chkjson", dataRoot: "~/.chkjson-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "chkjson", "--from", dir]).status).toBe(0);
    rmSync(agentDest("chkjson"));
    const res = run(["persona", "render", "chkjson", "--check", "--json"]);
    expect(res.status).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.drift.length).toBe(1);
    expect(payload.access.added).toBeGreaterThan(0);
    expect(payload.access.root).toBe(root("chkjson"));
    // --check 不写盘
    expect(existsSync(agentDest("chkjson"))).toBe(false);
  });

  test("persona update 非 JSON 分支输出 access 告警", () => {
    const dir = makePersona({ id: "updacc", dataRoot: "~/.updacc-agent", access: { write: true } });
    expect(run(["persona", "add", "updacc", "--from", dir]).status).toBe(0);
    const res = run(["persona", "update", "updacc"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("read!=true");
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

  test("非法 YAML 的 frontmatter 直接拒绝（不猜、不降级）", () => {
    expect(() => accessMod.composeAgentText("---\npermissions: [oops\n---\n", {
      id: "dabo3", dataRoot: "~/.dabo3-agent", access: { read: true }, homedir: home,
    })).toThrow(/E_MANIFEST/);
  });

  test("coversRoot：`/**` `/*` `**/*` `{a,b}/**` `?` 都算覆盖", () => {
    const opts = (resource: string) => ({
      id: "rc", dataRoot: "~/.rc-agent", access: { write: true }, homedir: home,
    });
    const R = join(home, ".rc-agent");
    for (const deny of ["/**", "/*", "**/*", `{${R},/var/tmp}/**`, `${home}/.r?-agent/**`]) {
      const src = `---\npermissions:\n  - action: edit\n    resource: ${JSON.stringify(deny)}\n    effect: deny\n---\nbody\n`;
      expect(() => accessMod.composeAgentText(src, opts(deny))).toThrow(/E_MANIFEST/);
    }
  });

  test("brace 覆盖必须真的靠 expandBraces（对照组：不展开就抓不住）", () => {
    const R = join(home, ".rc-agent");
    // /var/tmp 不是 home 的祖先：只有 `{R,/var/tmp}` 里的 R 分支能覆盖 root
    expect(accessMod.coversRoot(`{${R},/var/tmp}/**`, R, home)).toBe(true);
    // 同一模式不做 brace 展开时 singleCovers 必须为 false —— 否则上面的用例是假通过
    expect(accessMod.singleCovers(`{${R},/var/tmp}/**`, R)).toBe(false);
    expect(accessMod.singleCovers(`${R}/**`, R)).toBe(true);
  });
});

// ---- ⑮ persona use：目标版本口径 + 预检先于切指针（HIGH） --------------------
describe("⑮ persona use 选版本与 access 预检", () => {
  const slotEntry = (id: string, v: string) =>
    join(data, "personas", id, `${v}+local`, "agents", `${id}.md`);
  const installV = (id: string, v: string, force = false) => {
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, manifestExtra: { version: v } });
    return run(["persona", "add", id, "--from", dir, ...(force ? ["--force"] : [])]);
  };
  const activeRaw = (): any => {
    try { return JSON.parse(readFileSync(join(data, "state", "active.json"), "utf8")); }
    catch { return {}; }
  };
  const BAD = "---\npermissions:\n  - action: read\n---\nbody\n"; // 缺 resource/effect

  test("0.9.0 合法 / 0.10.0 非法：use 选 0.10.0 → 32，指针未动；0.9.0 不被误拒", () => {
    expect(installV("useord", "0.9.0").status).toBe(0);
    expect(installV("useord", "0.10.0", true).status).toBe(0);
    writeFileSync(slotEntry("useord", "0.10.0"), BAD);
    const before = activeRaw();
    const r = run(["persona", "use", "useord"]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_MANIFEST");
    expect(activeRaw()).toEqual(before);
    expect(activeRaw().useord).toBeUndefined();
    const ok = run(["persona", "use", "useord@0.9.0"]);
    expect(ok.status).toBe(0);
    expect(activeRaw().useord.version).toBe("0.9.0+local");
  });

  test("0.10.0 合法 / 0.9.0 非法：use 选 0.10.0 → 0；显式 0.9.0 → 32 且指针不动", () => {
    expect(installV("userev", "0.10.0").status).toBe(0);
    expect(installV("userev", "0.9.0", true).status).toBe(0);
    writeFileSync(slotEntry("userev", "0.9.0"), BAD);
    const ok = run(["persona", "use", "userev"]);
    expect(ok.status).toBe(0);
    expect(activeRaw().userev.version).toBe("0.10.0+local");
    const bad = run(["persona", "use", "userev@0.9.0"]);
    expect(bad.status).toBe(32);
    expect(bad.stderr).toContain("E_MANIFEST");
    expect(activeRaw().userev.version).toBe("0.10.0+local");
  });
});

// ---- ⑯ permissions 项字段残缺：opencode 会整份丢弃 → 必须 32（HIGH） --------
describe("⑯ permissions 项字段残缺/类型错 → fail closed", () => {
  const cases: Record<string, string[]> = {
    "p-missing": ["  - action: read"],
    "p-num": ["  - action: read", "    resource: 123", "    effect: allow"],
    "p-effect": ["  - action: read", '    resource: "~/.p-effect-agent/**"', "    effect: Allow"],
  };
  for (const [id, perm] of Object.entries(cases)) {
    test(`${id}: 32 + 行号 + dest 未创建`, () => {
      const body = ["---", "description: badperm", "permissions:", ...perm, "---", "body", ""].join("\n");
      const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
      const r = run(["persona", "add", id, "--from", dir]);
      expectReject(r, id);
      expect(r.stderr).toMatch(/第 \d+ 行/);
    });
  }

  test("dest 已有哨兵字节 → 32 且一个字节都不改", () => {
    const body = "---\ndescription: x\npermissions:\n  - action: read\n---\nbody\n";
    const dir = makePersona({ id: "p-sentinel", dataRoot: "~/.p-sentinel-agent", access: { read: true }, body });
    const dest = agentDest("p-sentinel");
    writeFileSync(dest, "SENTINEL\n");
    const r = run(["persona", "add", "p-sentinel", "--from", dir, "--force"]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_MANIFEST");
    expect(readFileSync(dest, "utf8")).toBe("SENTINEL\n");
  });
});

// ---- ⑰ 等价规则存在但顺序会失效 → 32（MEDIUM） ------------------------------
describe("⑰ 等价规则顺序失效（added=0 但规则实际无效）", () => {
  const permLines = (R: string, effectStarFirst: boolean) => {
    const eq = [
      "  - action: external_directory",
      `    resource: ${R}/**`,
      "    effect: allow",
      "  - action: read",
      `    resource: ${R}/**`,
      "    effect: allow",
      "  - action: edit",
      `    resource: ${R}/**`,
      "    effect: allow",
      "  - action: read",
      `    resource: ${R}/*.env`,
      "    effect: ask",
      "  - action: read",
      `    resource: ${R}/*.env.*`,
      "    effect: ask",
    ];
    const star = ["  - action: \"*\"", "    resource: \"*\"", "    effect: ask"];
    return effectStarFirst ? [...star, ...eq] : [...eq, ...star];
  };

  test("`*: ask` 排在等价 allow 之后 → 32（提示调整顺序）", () => {
    const id = "ord-star";
    const R = root(id);
    const body = ["---", "description: order", "permissions:", ...permLines(R, false), "---", "body", ""].join("\n");
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true }, body });
    const r = run(["persona", "add", id, "--from", dir]);
    expectReject(r, id);
    expect(r.stderr).toMatch(/调整顺序|覆盖/);
  });

  test(".env ask 排在 read allow 之前 → 32", () => {
    const id = "ord-env";
    const R = root(id);
    const body = [
      "---",
      "description: order",
      "permissions:",
      "  - action: read",
      `    resource: ${R}/*.env`,
      "    effect: ask",
      "  - action: read",
      `    resource: ${R}/*.env.*`,
      "    effect: ask",
      "  - action: read",
      `    resource: ${R}/**`,
      "    effect: allow",
      "  - action: edit",
      `    resource: ${R}/**`,
      "    effect: deny",
      "  - action: external_directory",
      `    resource: ${R}/**`,
      "    effect: allow",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
    const r = run(["persona", "add", id, "--from", dir]);
    expectReject(r, id);
    expect(r.stderr).toMatch(/调整顺序|覆盖/);
  });

  test("顺序正确 + 末尾精确路径规则 → 仍成功且字节不变（不误拒）", () => {
    const id = "ord-ok";
    const R = root(id);
    const body = [
      "---",
      "description: order",
      "permissions:",
      '  - action: "*"',
      '    resource: "*"',
      "    effect: ask",
      ...permLines(R, false).slice(0, 15),
      "  - action: read",
      `    resource: ${R}/*.secret`,
      "    effect: allow",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true }, body });
    const r = run(["persona", "add", id, "--from", dir]);
    expect(r.status).toBe(0);
    expect(readFileSync(agentDest(id), "utf8")).toBe(body);
  });
});

// ---- ⑱ homedir 口径统一（MEDIUM） ------------------------------------------
describe("⑱ render/verify 的 homedir 都以 lock 为准", () => {
  test("换 DIA_HOME：--check 无 drift、有 warn；真渲染不改路径", () => {
    const id = "rehome1";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const dest = agentDest(id);
    const before = readFileSync(dest, "utf8");
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h2-"));
    const chk = run(["persona", "render", id, "--check", "--json"], { DIA_HOME: home2 });
    expect(chk.status).toBe(0);
    const payload = JSON.parse(chk.stdout);
    expect(payload.drift).toEqual([]);
    expect(payload.access.warnings.join("\n")).toContain("homedir 与安装时不同");
    expect(readFileSync(dest, "utf8")).toBe(before);
    const rr = run(["persona", "render", id], { DIA_HOME: home2 });
    expect(rr.status).toBe(0);
    expect(readFileSync(dest, "utf8")).toBe(before);
  });

  test("--rehome 才改路径并更新 lock", () => {
    const id = "rehome2";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h3-"));
    const rr = run(["persona", "render", id, "--rehome"], { DIA_HOME: home2 });
    expect(rr.status).toBe(0);
    const text = readFileSync(agentDest(id), "utf8");
    expect(text).toContain(join(home2, `.${id}-agent`));
    // lock 跟着改写；之后用新 home 校验一致
    const slot = join(data, "personas", id, "0.1.0+local", "dia.lock");
    const lock = JSON.parse(readFileSync(slot, "utf8"));
    expect(lock.access.homedir).toBe(home2);
    expect(run(["persona", "verify", id], { DIA_HOME: home2 }).status).toBe(0);
  });
});

// ---- ⑲ --check 的 added 口径（MEDIUM） -------------------------------------
describe("⑲ render --check 的 access.added = dest 相对期望缺几条", () => {
  test("一致时 added=0、skipped=0；非 --check 一致时 added 也为 0", () => {
    const id = "chkzero";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const chk = run(["persona", "render", id, "--check", "--json"]);
    expect(chk.status).toBe(0);
    const p = JSON.parse(chk.stdout);
    expect(p.access.added).toBe(0);
    expect(p.access.skipped).toBe(0);
    const rr = run(["persona", "render", id, "--json"]);
    expect(rr.status).toBe(0);
    expect(JSON.parse(rr.stdout).access.added).toBe(0);
  });
});

// ---- ⑳ persona check 不吞 E_MANIFEST（LOW） --------------------------------
describe("⑳ persona check 透传 access 错误", () => {
  test("坏 permissions 项 → 32 + 原始 E_MANIFEST 信息", () => {
    const id = "chkbad";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const slot = join(data, "personas", id, "0.1.0+local", "agents", `${id}.md`);
    writeFileSync(slot, "---\npermissions:\n  - action: read\n---\nbody\n");
    const r = run(["persona", "check", id]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_MANIFEST");
    expect(r.stdout).not.toContain("MISMATCH");
  });
});

// ---- ㉑ 混合换行：body 逐字节保留（LOW） ------------------------------------
describe("㉑ 混合换行 body 不被统一改写", () => {
  test("frontmatter 按块自身 LF；body 的 CRLF 原样保留", async () => {
    const accessMod: any = await import("../src/persona-access.ts");
    const src = "---\ndescription: mixed\n---\r\nline1\r\nline2\r\n";
    const out = accessMod.composeAgentText(src, {
      id: "mix", dataRoot: "~/.mix-agent", access: { read: true }, homedir: home,
    });
    expect(out.text.startsWith("---\n")).toBe(true);
    expect(out.text).not.toContain("description: mixed\r\n");
    const idx = out.text.lastIndexOf("---\r\n");
    expect(out.text.slice(idx)).toBe("---\r\nline1\r\nline2\r\n");
  });
});
