import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    // opencode 里花括号是字面量、只有 * / ? 通配：用真实通配写法验证覆盖
    { id: "deny-star", resource: () => join(home, "*-agent/**") },
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

  test("env=true → 没有 .env ask（数据根内任意深度 .env 读取免确认）", () => {
    const dir = makePersona({ id: "envon", dataRoot: "~/.envon-agent", access: { read: true, write: true, env: true } });
    expect(run(["persona", "add", "envon", "--from", dir]).status).toBe(0);
    const perms = fm(readFileSync(agentDest("envon"), "utf8")).permissions as any[];
    expect(perms.some((p) => p.effect === "ask" && /(^|\/)\.env(\.|$)/.test(String(p.resource)))).toBe(false);
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

  test("换 HOME 重跑 verify：拒绝（32），提示 --rehome / 换回原 HOME", () => {
    const dir = makePersona({ id: "vfyhome", dataRoot: "~/.vfyhome-agent", access: { read: true, write: true } });
    expect(run(["persona", "add", "vfyhome", "--from", dir]).status).toBe(0);
    const other = mkdtempSync(join(tmpdir(), "dia-pa-otherhome-"));
    const res = run(["persona", "verify", "vfyhome"], { DIA_HOME: other });
    expect(res.status).toBe(32);
    expect(res.stderr).toContain("E_MANIFEST");
    expect(res.stderr).toContain("--rehome");
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

  test("coversRoot：`/**` `/*` `**/*` `?` `*` 都算覆盖", () => {
    const R = join(home, ".rc-agent");
    for (const deny of ["/**", "/*", "**/*", `${home}/.r?-agent/**`, `${home}/*-agent/**`]) {
      expect(accessMod.coversRoot(deny, R, home)).toBe(true);
    }
  });

  test("花括号不是 glob：`{root,/tmp}/**` 是字面路径，不算覆盖（opencode 只把 * / ? 当通配）", () => {
    const R = join(home, ".rc-agent");
    expect(accessMod.coversRoot(`{${R},/var/tmp}/**`, R, home)).toBe(false);
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
  test("换 DIA_HOME：--check 与真渲染都拒绝，产物 / lock 不变", () => {
    const id = "rehome1";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const dest = agentDest(id);
    const lockPath = join(data, "personas", id, "0.1.0+local", "dia.lock");
    const before = readFileSync(dest, "utf8");
    const lockBefore = readFileSync(lockPath, "utf8");
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h2-"));
    const chk = run(["persona", "render", id, "--check", "--json"], { DIA_HOME: home2 });
    expect(chk.status).toBe(32);
    expect(chk.stderr).toContain("E_MANIFEST");
    expect(chk.stderr).toContain("--rehome");
    expect(readFileSync(dest, "utf8")).toBe(before);
    const rr = run(["persona", "render", id], { DIA_HOME: home2 });
    expect(rr.status).toBe(32);
    expect(readFileSync(dest, "utf8")).toBe(before);
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
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

// ---- ⑲ added / missing 口径（MEDIUM） --------------------------------------
describe("⑲ render 的 access.added = 本次合成新增条数；missing = dest 相对期望缺几条", () => {
  test("一致时 added=合成新增数（5）、missing=0；--check 与真渲染同口径", () => {
    const id = "chkzero";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const chk = run(["persona", "render", id, "--check", "--json"]);
    expect(chk.status).toBe(0);
    const p = JSON.parse(chk.stdout);
    // external_directory allow + read allow + edit allow + 两条 .env ask
    expect(p.access.added).toBe(5);
    expect(p.access.missing).toBe(0);
    expect(p.access.skipped).toBe(0);
    const rr = run(["persona", "render", id, "--json"]);
    expect(rr.status).toBe(0);
    expect(JSON.parse(rr.stdout).access.added).toBe(5);
    expect(JSON.parse(rr.stdout).access.missing).toBe(0);
  });

  test("dest 缺失：added 只算合成新增（不含作者已有规则），missing 才是全部期望条数", () => {
    const id = "chkmiss";
    const R = root(id);
    const body = ["---", "description: x", "permissions:", '  - action: "*"', '    resource: "*"', "    effect: ask", "---", "body", ""].join("\n");
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    rmSync(agentDest(id));
    const chk = run(["persona", "render", id, "--check", "--json"]);
    expect(chk.status).toBe(1);
    const p = JSON.parse(chk.stdout);
    expect(p.access.added).toBe(5); // external/read/edit + 2 条 .env ask
    expect(p.access.missing).toBe(6); // 期望 = 作者已有 1 条 + 合成 5 条
    expect(p.access.root).toBe(R);
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

// ---- ㉒ lock 存在但不可解析：拒绝写盘（HIGH） -------------------------------
describe("㉒ 坏 lock / null lock：拒绝操作且不改字节", () => {
  const cases: [string, string][] = [["lockbad", "{not json"], ["locknull", "null"]];
  for (const [id, bad] of cases) {
    test(`${id}: 退出非 0、报 E_LOCKED、lock 与产物字节不变`, () => {
      const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
      expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
      const slotDir = join(data, "personas", id);
      const slot = join(slotDir, readdirSync(slotDir)[0]);
      const lockPath = join(slot, "dia.lock");
      const dest = agentDest(id);
      const destBefore = readFileSync(dest, "utf8");
      writeFileSync(lockPath, bad);
      const r = run(["persona", "render", id]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("E_LOCKED");
      expect(readFileSync(lockPath, "utf8")).toBe(bad);
      expect(readFileSync(dest, "utf8")).toBe(destBefore);
    });
  }
});

// ---- ㉓ alias / merge key 不再被误拒（LOW） ---------------------------------
describe("㉓ permissions 里的 alias / merge key 正常合成", () => {
  test("`- &r {...}` + `- *r` 可以合成（值走 toJS resolve）", () => {
    const id = "alias4";
    const R = root(id);
    const body = [
      "---",
      "description: alias",
      "permissions:",
      "  - &r",
      "    action: read",
      `    resource: ${R}/secret`,
      "    effect: allow",
      "  - *r",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
    const r = run(["persona", "add", id, "--from", dir]);
    expect(r.status).toBe(0);
    const perms = fm(readFileSync(agentDest(id), "utf8")).permissions as any[];
    expect(perms.length).toBe(2 + 5); // 2 条作者规则 + access(read) 合成 5 条（含 2 条 .env ask）
  });

  test("`- <<: *base` 可以合成且保留 merge 写法", () => {
    const id = "merge4";
    const R = root(id);
    const body = [
      "---",
      "description: merge",
      "base: &base",
      "  action: read",
      `  resource: ${R}/secret`,
      "  effect: allow",
      "permissions:",
      "  - <<: *base",
      "---",
      "body",
      "",
    ].join("\n");
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
    const r = run(["persona", "add", id, "--from", dir]);
    expect(r.status).toBe(0);
    const text = readFileSync(agentDest(id), "utf8");
    expect(text).toContain("<<: *base");
    expect((fm(text).permissions as any[]).length).toBe(1 + 5);
  });
});

// ---- ㉔ 中缀 glob 覆盖顺序（MEDIUM） ---------------------------------------
describe("㉔ 中缀 / 裸 glob 的 allow 排在 ask 之后 → 32", () => {
  const mk = (id: string, later: string) => {
    const R = root(id);
    const body = [
      "---",
      "description: midglob",
      "permissions:",
      "  - action: read",
      `    resource: ${R}/*.env`,
      "    effect: ask",
      "  - action: read",
      `    resource: ${R}/*.env.*`,
      "    effect: ask",
      "  - action: read",
      `    resource: ${JSON.stringify(later)}`,
      "    effect: allow",
      "---",
      "body",
      "",
    ].join("\n");
    return makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, body });
  };

  test("`R/**/.env` 覆盖前面的 `.env ask` → 32", () => {
    const id = "mid-a";
    const dir = mk(id, `${root(id)}/**/.env`);
    const r = run(["persona", "add", id, "--from", dir]);
    expectReject(r, id);
    expect(r.stderr).toMatch(/调整顺序|覆盖/);
  });

  test("`**.env` 覆盖前面的 `.env ask` → 32", () => {
    const id = "mid-b";
    const dir = mk(id, "**.env");
    const r = run(["persona", "add", id, "--from", dir]);
    expectReject(r, id);
    expect(r.stderr).toMatch(/调整顺序|覆盖/);
  });
});

// ---- ㉕ 标量错误文案（LOW） -------------------------------------------------
describe("㉕ 非字符串字段报真实标量值（不再是 null）", () => {
  test("resource: 123 → 收到 123；effect: true → 收到 true", async () => {
    const accessMod: any = await import("../src/persona-access.ts");
    const opts = { id: "scalar", dataRoot: "~/.scalar-agent", access: { read: true }, homedir: home };
    let msg = "";
    try {
      accessMod.composeAgentText("---\npermissions:\n  - action: read\n    resource: 123\n    effect: allow\n---\n", opts);
    } catch (e: any) { msg = String(e?.message ?? e); }
    expect(msg).toContain("123");
    expect(msg).not.toContain("null");
    try {
      accessMod.composeAgentText("---\npermissions:\n  - action: read\n    resource: x\n    effect: true\n---\n", opts);
    } catch (e: any) { msg = String(e?.message ?? e); }
    expect(msg).toContain("true");
    expect(msg).not.toContain("null");
  });
});

// ---- ㉖ --check 与 --rehome 互斥（LOW） ------------------------------------
describe("㉖ --check --rehome 互斥", () => {
  test("同时出现 → 退出 2、提示互斥、不写盘", () => {
    const id = "chkrehome";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const slotDir = join(data, "personas", id);
    const lockPath = join(slotDir, readdirSync(slotDir)[0], "dia.lock");
    const lockBefore = readFileSync(lockPath, "utf8");
    const destBefore = readFileSync(agentDest(id), "utf8");
    const r = run(["persona", "render", id, "--check", "--rehome"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("互斥");
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
    expect(readFileSync(agentDest(id), "utf8")).toBe(destBefore);
  });
});

// ---- ㉗ persona use 预检包含 content 渲染（LOW） ----------------------------
describe("㉗ persona use 预检跑 kit.renderContent（失败先于 active.use）", () => {
  test("槽位内 skills 源缺失 → use 非 0 且 active 指针未动", () => {
    const id = "usecnt";
    const dir = makePersona({ id, manifestExtra: { skills: [{ from: "skills/x", name: "x" }] } });
    mkdirSync(join(dir, "skills", "x"), { recursive: true });
    writeFileSync(join(dir, "skills", "x", "SKILL.md"), "x\n");
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const slotDir = join(data, "personas", id);
    const slot = join(slotDir, readdirSync(slotDir)[0]);
    rmSync(join(slot, "skills", "x"), { recursive: true, force: true });
    const activeFile = join(data, "state", "active.json");
    const before = existsSync(activeFile) ? readFileSync(activeFile, "utf8") : "";
    const r = run(["persona", "use", id]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("E_MANIFEST");
    const after = existsSync(activeFile) ? readFileSync(activeFile, "utf8") : "";
    expect(after).toBe(before);
    expect(after).not.toContain(id);
  });
});

// ---- ㉘ 坏 lock × 六个入口：统一 32（HIGH） ---------------------------------
describe("㉘ 坏 lock（坏 JSON / null）在 verify/render/use/check/update/add 都统一 32", () => {
  const entries = ["verify", "render", "use", "check", "update", "add"] as const;
  const bads: [string, string][] = [["badjson", "{not json"], ["null", "null"]];
  for (const [kind, bad] of bads) {
    for (const entry of entries) {
      test(`${entry} × ${kind} → 32 + E_LOCKED，lock/产物字节不变`, () => {
        const id = `lk-${entry}-${kind}`;
        const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
        expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
        const slotDir = join(data, "personas", id);
        const slot = join(slotDir, readdirSync(slotDir)[0]);
        const lockPath = join(slot, "dia.lock");
        const dest = agentDest(id);
        const destBefore = readFileSync(dest, "utf8");
        writeFileSync(lockPath, bad);
        const args = entry === "add"
          ? ["persona", "add", id, "--from", dir]
          : ["persona", entry, id];
        const r = run(args);
        expect(r.status).toBe(32);
        expect(r.stderr).toContain("E_LOCKED");
        expect(readFileSync(lockPath, "utf8")).toBe(bad);
        expect(readFileSync(dest, "utf8")).toBe(destBefore);
      });
    }
  }
});

// ---- ㉙ 跨 HOME：add --force / update 也必须拒绝（MEDIUM） --------------------
describe("㉙ 跨 HOME 时 add/update 不能绕过闸门", () => {
  test("同槽位再 add（含 --force）跨 HOME → 32，提示 --rehome，产物不变", () => {
    const id = "rehomeadd";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const dest = agentDest(id);
    const before = readFileSync(dest, "utf8");
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-add-"));
    for (const extra of [[], ["--force"], ["--dry-run"]]) {
      const r = run(["persona", "add", id, "--from", dir, ...extra], { DIA_HOME: home2 });
      expect(r.status).toBe(32);
      expect(r.stderr).toContain("E_MANIFEST");
      expect(r.stderr).toContain("--rehome");
      expect(readFileSync(dest, "utf8")).toBe(before);
    }
    // --rehome 放行：产物改写成新 HOME 的数据根
    const ok = run(["persona", "add", id, "--from", dir, "--force", "--rehome"], { DIA_HOME: home2 });
    expect(ok.status).toBe(0);
    expect(readFileSync(dest, "utf8")).toContain(join(home2, `.${id}-agent`));
  });

  test("update 跨 HOME → 32；加 --rehome 才成功且 lock.access.homedir 更新", () => {
    const id = "rehomeupd";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const slotDir = join(data, "personas", id);
    const slot = join(slotDir, readdirSync(slotDir)[0]);
    const lockPath = join(slot, "dia.lock");
    const lockBefore = readFileSync(lockPath, "utf8");
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-upd-"));
    const bad = run(["persona", "update", id], { DIA_HOME: home2 });
    expect(bad.status).toBe(32);
    expect(bad.stderr).toContain("E_MANIFEST");
    expect(bad.stderr).toContain("--rehome");
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
    const ok = run(["persona", "update", id, "--rehome"], { DIA_HOME: home2 });
    expect(ok.status).toBe(0);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).access.homedir).toBe(home2);
  });
});

// ---- ㉚ render --host dsh|codex 不改写 lock.access.added/skipped（LOW） ------
describe("㉚ render --host dsh 保留 lock 里的 access.added/skipped", () => {
  test("opencode 装完 added=5；再 render --host dsh 仍为 5，并打印不生效告警", () => {
    const id = "dhspres";
    const dir = mkdtempSync(join(tmpdir(), `dia-pa-${id}-`));
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "platform", "dsh", "p"), { recursive: true });
    writeFileSync(join(dir, "agents", `${id}.md`), `---\ndescription: ${id}\nmode: primary\n---\nYou are ${id}.\n`);
    writeFileSync(join(dir, "platform", "dsh", "p", "cordis.yml"), "[]\n");
    writeFileSync(join(dir, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id, version: "0.1.0",
      hosts: ["opencode", "dsh"],
      entry: { opencode: `agents/${id}.md`, dsh: "platform/dsh/p" },
      data_root: `~/.${id}-agent`,
      access: { read: true, write: true },
    }));
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const slotDir = join(data, "personas", id);
    const slot = join(slotDir, readdirSync(slotDir)[0]);
    const lockPath = join(slot, "dia.lock");
    const before = JSON.parse(readFileSync(lockPath, "utf8")).access;
    expect(before.added).toBe(5);
    expect(before.skipped).toBe(0);
    const r = run(["persona", "render", id, "--host", "dsh"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("access 对 host=dsh 本期不生效");
    const after = JSON.parse(readFileSync(lockPath, "utf8")).access;
    expect(after.added).toBe(before.added);
    expect(after.skipped).toBe(before.skipped);
    expect(after.root).toBe(before.root);
  });
});

// ============================================================================
// 第五轮评审：--force 恢复路径 / rehome 残留 / remove 坏 lock / 字面 `[` 等
// ============================================================================

const idDirOf = (id: string) => join(data, "personas", id);
const slotOf = (id: string, ver: string) => join(idDirOf(id), ver);
const lockOf = (id: string, ver: string) => join(slotOf(id, ver), "dia.lock");
// 坏 lock 备份现在在 data 备份根（评审 HIGH：不能放进 personas/<id>/，否则会被当版本）
const backupsOf = (id: string) => join(data, "backups", "persona-locks", id);
const hasLockBackup = (id: string) =>
  existsSync(backupsOf(id)) && readdirSync(backupsOf(id)).some((n) => n.includes("dia.lock.bak"));

describe("㉛ 坏 lock × --force：先备份再覆盖重装", () => {
  for (const [entry, forceArgs, ver] of [
    ["add", ["persona", "add", "lkbak", "--from", ""], "0.1.0+local"],
    ["update", ["persona", "update", "lkbak", "--force"], "0.1.0+local"],
  ] as const) {
    test(`${entry} --force：坏 lock → 0 且生成备份；无 force 仍 32 且字节不变`, () => {
      const id = "lkbak";
      const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
      expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
      const lockPath = lockOf(id, ver);
      const dest = agentDest(id);
      const destBefore = readFileSync(dest, "utf8");

      writeFileSync(lockPath, "{not json");
      const no = run(entry === "add" ? ["persona", "add", id, "--from", dir] : ["persona", "update", id]);
      expect(no.status).toBe(32);
      expect(no.stderr).toContain("E_LOCKED");
      expect(readFileSync(lockPath, "utf8")).toBe("{not json");
      expect(readFileSync(dest, "utf8")).toBe(destBefore);

      const yes = run(entry === "add" ? ["persona", "add", id, "--from", dir, "--force"] : ["persona", "update", id, "--force"]);
      if (yes.status !== 0) console.error(yes.stdout, yes.stderr);
      expect(yes.status).toBe(0);
      expect(hasLockBackup(id)).toBe(true);
      // 重装后 lock 恢复可解析
      expect(() => JSON.parse(readFileSync(lockPath, "utf8"))).not.toThrow();
      expect(run(["persona", "verify", id]).status).toBe(0);
    });
  }
});

describe("㉜ render --rehome 对非 opencode 宿主必须报错且不改 access.homedir", () => {
  test("--host dsh --rehome → 2；lock.access.homedir 不变（没有 homedir=B/root=A）", () => {
    const id = "rehdsh";
    const dir = mkdtempSync(join(tmpdir(), `dia-pa-${id}-`));
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "platform", "dsh", "p"), { recursive: true });
    writeFileSync(join(dir, "agents", `${id}.md`), `---\ndescription: ${id}\n---\nbody\n`);
    writeFileSync(join(dir, "platform", "dsh", "p", "cordis.yml"), "[]\n");
    writeFileSync(join(dir, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id, version: "0.1.0",
      hosts: ["opencode", "dsh"],
      entry: { opencode: `agents/${id}.md`, dsh: "platform/dsh/p" },
      data_root: `~/.${id}-agent`, access: { read: true },
    }));
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-dsh-"));
    const lockPath = lockOf(id, "0.1.0+local");
    const before = JSON.parse(readFileSync(lockPath, "utf8")).access;
    const r = run(["persona", "render", id, "--host", "dsh", "--rehome"], { DIA_HOME: home2 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("opencode");
    const after = JSON.parse(readFileSync(lockPath, "utf8")).access;
    expect(after).toEqual(before);
    expect(after.homedir).toBe(home);
  });
});

describe("㉝ remove 遇坏 lock：32 且一个文件都不动（两版本，坏的是第二个）", () => {
  test("两版本目录与共享 agent md 都还在", () => {
    const id = "rmbad";
    const d1 = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, manifestExtra: { version: "0.1.0" } });
    const d2 = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true }, manifestExtra: { version: "0.2.0" } });
    expect(run(["persona", "add", id, "--from", d1]).status).toBe(0);
    expect(run(["persona", "add", id, "--from", d2]).status).toBe(0);
    const v1 = slotOf(id, "0.1.0+local"), v2 = slotOf(id, "0.2.0+local");
    expect(existsSync(v1) && existsSync(v2)).toBe(true);
    const destBefore = readFileSync(agentDest(id), "utf8");
    writeFileSync(join(v2, "dia.lock"), "null");
    const r = run(["persona", "remove", id]);
    expect(r.status).toBe(32);
    expect(r.stderr).toContain("E_LOCKED");
    expect(existsSync(v1)).toBe(true);
    expect(existsSync(v2)).toBe(true);
    expect(readFileSync(agentDest(id), "utf8")).toBe(destBefore);
    expect(readFileSync(join(v2, "dia.lock"), "utf8")).toBe("null");
  });
});

describe("㉞ add --rehome：隐含覆盖既有产物；--dry-run --json 仍是 JSON", () => {
  test("--rehome 不加 --force 也能覆盖旧 HOME 的 dest", () => {
    const id = "rehimp";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-imp-"));
    const j = run(["persona", "add", id, "--from", dir, "--rehome", "--dry-run", "--json"], { DIA_HOME: home2 });
    expect(j.status).toBe(0);
    const payload = JSON.parse(j.stdout); // 必须是 JSON，不能抛非 JSON 错误
    expect(payload.id).toBe(id);
    expect(Array.isArray(payload.retired)).toBe(true);
    // dry-run 不写盘：dest 仍是旧 HOME 的规则
    expect(readFileSync(agentDest(id), "utf8")).toContain(join(home, `.${id}-agent`));
    const ok = run(["persona", "add", id, "--from", dir, "--rehome"], { DIA_HOME: home2 });
    if (ok.status !== 0) console.error(ok.stdout, ok.stderr);
    expect(ok.status).toBe(0);
    expect(readFileSync(agentDest(id), "utf8")).toContain(join(home2, `.${id}-agent`));
  });

  test("--dry-run --json 含迁移动作（旧 dest 仍在，retired 列出但不删）", () => {
    const id = "rehjson";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    const agentsA = join(data, "agents-A"), agentsB = join(data, "agents-B");
    mkdirSync(agentsA, { recursive: true });
    mkdirSync(agentsB, { recursive: true });
    expect(run(["persona", "add", id, "--from", dir], { DIA_OPENCODE_AGENTS_DIR: agentsA }).status).toBe(0);
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-json-"));
    const j = run(["persona", "add", id, "--from", dir, "--rehome", "--dry-run", "--json"], {
      DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB,
    });
    expect(j.status).toBe(0);
    const payload = JSON.parse(j.stdout);
    expect(payload.retired).toContain(join(agentsA, `${id}.md`));
    expect(existsSync(join(agentsA, `${id}.md`))).toBe(true);
  });
});

describe("㉟ rehome 残留：旧 dest 记入 renderedRetired 并删除；verify/remove 不再报错", () => {
  test("render A→B：旧文件删除、verify=0、remove=0", () => {
    const id = "rehmove";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true, write: true } });
    const agentsA = join(data, "agents-A2"), agentsB = join(data, "agents-B2");
    mkdirSync(agentsA, { recursive: true });
    mkdirSync(agentsB, { recursive: true });
    expect(run(["persona", "add", id, "--from", dir], { DIA_OPENCODE_AGENTS_DIR: agentsA }).status).toBe(0);
    const destA = join(agentsA, `${id}.md`);
    expect(existsSync(destA)).toBe(true);
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-move-"));
    const rr = run(["persona", "render", id, "--rehome"], { DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB });
    if (rr.status !== 0) console.error(rr.stdout, rr.stderr);
    expect(rr.status).toBe(0);
    const destB = join(agentsB, `${id}.md`);
    expect(existsSync(destB)).toBe(true);
    expect(existsSync(destA)).toBe(false);
    expect(rr.stdout).toContain(destA); // 删前/删后都打印路径
    const lock = JSON.parse(readFileSync(lockOf(id, "0.1.0+local"), "utf8"));
    expect(lock.rendered).not.toContain(destA);
    expect(lock.renderedHashes[destA]).toBeUndefined();
    expect(lock.renderedRetired).toContain(destA);
    expect(run(["persona", "verify", id], { DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB }).status).toBe(0);
    const rm = run(["persona", "remove", id], { DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB });
    expect(rm.status).toBe(0);
    expect(rm.stdout).not.toContain("skipped");
  });
});

describe("㊱ `[` 是字面量，不是字符类", () => {
  test("`<root>/.rc[-]agent/**` 不覆盖 `.rc-agent`", async () => {
    const accessMod: any = await import("../src/persona-access.ts");
    const R = join(home, ".rc-agent");
    const pat = join(home, ".rc[-]agent") + "/**";
    expect(accessMod.singleCovers(pat, R)).toBe(false);
    expect(accessMod.coversRoot(pat, R, home)).toBe(false);
    // 对照：真正的 `?` 通配仍算覆盖
    expect(accessMod.coversRoot(join(home, ".r?-agent") + "/**", R, home)).toBe(true);
  });
});

describe("㊲ render --host dsh 的汇总行与 lock 一致（不再打印追加 0 条）", () => {
  test("stdout 的 added/skipped 等于 lock 里的值", () => {
    const id = "dhssum";
    const dir = mkdtempSync(join(tmpdir(), `dia-pa-${id}-`));
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "platform", "dsh", "p"), { recursive: true });
    writeFileSync(join(dir, "agents", `${id}.md`), `---\ndescription: ${id}\n---\nbody\n`);
    writeFileSync(join(dir, "platform", "dsh", "p", "cordis.yml"), "[]\n");
    writeFileSync(join(dir, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id, version: "0.1.0",
      hosts: ["opencode", "dsh"],
      entry: { opencode: `agents/${id}.md`, dsh: "platform/dsh/p" },
      data_root: `~/.${id}-agent`, access: { read: true, write: true },
    }));
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const r = run(["persona", "render", id, "--host", "dsh"]);
    expect(r.status).toBe(0);
    const access = JSON.parse(readFileSync(lockOf(id, "0.1.0+local"), "utf8")).access;
    expect(access.added).toBeGreaterThan(0);
    expect(r.stdout).toContain(`access: 追加 ${access.added} 条（跳过 ${access.skipped}）`);
    expect(r.stdout).toContain("access 对 host=dsh 本期不生效");
  });
});

describe("㊳ 嵌套 versions/<v> 布局 + update --rehome 行为确定", () => {
  test("已有 versions/ 布局时 update --rehome 成功（同槽位幂等），lock/verify 一致", () => {
    const id = "nestupd";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const idDir = idDirOf(id);
    const flat = slotOf(id, "0.1.0+local");
    mkdirSync(join(idDir, "versions"), { recursive: true });
    renameSync(flat, join(idDir, "versions", "0.1.0+local"));
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-nest-"));
    const r = run(["persona", "update", id, "--rehome"], { DIA_HOME: home2 });
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    const versions = readdirSync(join(idDir, "versions"));
    expect(versions).toContain("0.1.0+local");
    const lock = JSON.parse(readFileSync(join(idDir, "versions", "0.1.0+local", "dia.lock"), "utf8"));
    expect(lock.access.homedir).toBe(home2);
    expect(run(["persona", "verify", id], { DIA_HOME: home2 }).status).toBe(0);
  });
});

// ============================================================================
// 评审跟进：坏 lock 备份位置 / rehome 备份 / AGENTS.md 归属 / 失败可恢复 / 嵌套 scope
// ============================================================================

const listRow = (id: string) => {
  const r = run(["persona", "list", "--json"]);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout).find((row: any) => row.id === id);
};

describe("㊴ 坏 lock 备份落在 <data>/backups/persona-locks，不污染版本目录", () => {
  test("add --force：personas/<id>/backups 不存在；list 无 backups；gc --keep 1 不删备份", () => {
    const id = "lkbakroot";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);
    const slot = readdirSync(idDirOf(id)).find((n) => n.startsWith("0.1.0"))!;
    writeFileSync(lockOf(id, slot), "{bad");
    expect(run(["persona", "add", id, "--from", dir, "--force"]).status).toBe(0);

    expect(hasLockBackup(id)).toBe(true);
    expect(existsSync(join(idDirOf(id), "backups"))).toBe(false);

    const row = listRow(id);
    expect(row.versions).not.toContain("backups");
    expect(row.versions.length).toBe(1);

    // gc 只碰版本槽位：备份在 <data>/backups，不能被 --keep 删掉
    expect(run(["persona", "gc", id, "--keep", "1"]).status).toBe(0);
    expect(hasLockBackup(id)).toBe(true);
  });

  test("历史 personas/<id>/backups：不算版本；remove --version 后 active 不指向它并被清掉", () => {
    const id = "lklega";
    const d1 = makePersona({ id, manifestExtra: { version: "0.1.0" } });
    const d2 = makePersona({ id, manifestExtra: { version: "0.2.0" } });
    expect(run(["persona", "add", id, "--from", d1]).status).toBe(0);
    expect(run(["persona", "add", id, "--from", d2]).status).toBe(0);

    // 模拟历史遗留的 `<idDir>/backups/`
    const legacy = join(idDirOf(id), "backups");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "dia.lock.bak-legacy"), "{bad");

    const row = listRow(id);
    expect(row.versions.some((v: string) => v.startsWith("backups"))).toBe(false);
    expect(row.versions.length).toBe(2);

    // 让 0.1.0 成为生效版本：删它时必须重指到 0.2.0，而不是排序垫底的 backups
    expect(run(["persona", "use", `${id}@0.1.0`]).status).toBe(0);
    expect(run(["persona", "remove", id, "--version", "0.1.0"]).status).toBe(0);
    const active = JSON.parse(readFileSync(join(data, "state", "active.json"), "utf8"))[id];
    expect(active.version).not.toBe("backups");
    expect(active.version.startsWith("0.2.0")).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("㊵ rehome 清理旧 dest：先备份再删；手改过的保留并告警", () => {
  test("add --rehome：未改的旧 dest 备份到 <data>/backups/rehome-* 后才删", () => {
    const id = "rehbak";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    const agentsA = join(data, "agents-A3"), agentsB = join(data, "agents-B3");
    mkdirSync(agentsA, { recursive: true });
    mkdirSync(agentsB, { recursive: true });
    expect(run(["persona", "add", id, "--from", dir], { DIA_OPENCODE_AGENTS_DIR: agentsA }).status).toBe(0);
    const destA = join(agentsA, `${id}.md`);
    const before = readFileSync(destA, "utf8");
    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-rbak-"));
    const r = run(["persona", "add", id, "--from", dir, "--rehome"], { DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB });
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(existsSync(destA)).toBe(false);

    const bdirs = readdirSync(join(data, "backups")).filter((n) => n.startsWith(`rehome-${id}-`));
    expect(bdirs.length).toBeGreaterThan(0);
    const bdir = join(data, "backups", bdirs[bdirs.length - 1]);
    expect(readdirSync(bdir)).toContain(`${id}.md`);
    expect(readFileSync(join(bdir, `${id}.md`), "utf8")).toBe(before);
  });

  test("render --rehome：手改过的旧 dest 保留（kept-user-edited）+ 告警，verify 仍 0", () => {
    const id = "rehkeep";
    const dir = makePersona({ id, dataRoot: `~/.${id}-agent`, access: { read: true } });
    const agentsA = join(data, "agents-A4"), agentsB = join(data, "agents-B4");
    mkdirSync(agentsA, { recursive: true });
    mkdirSync(agentsB, { recursive: true });
    expect(run(["persona", "add", id, "--from", dir], { DIA_OPENCODE_AGENTS_DIR: agentsA }).status).toBe(0);
    const destA = join(agentsA, `${id}.md`);
    writeFileSync(destA, "user edited\n");

    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-rkeep-"));
    const r = run(["persona", "render", id, "--rehome"], { DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB });
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kept-user-edited");
    expect(existsSync(destA)).toBe(true);
    expect(readFileSync(destA, "utf8")).toBe("user edited\n");

    const lock = JSON.parse(readFileSync(lockOf(id, "0.1.0+local"), "utf8"));
    expect(lock.renderedRetired.some((e: any) => typeof e === "object" && e.path === destA && e.kept === "user-edited")).toBe(true);
    expect(run(["persona", "verify", id], { DIA_HOME: home2, DIA_OPENCODE_AGENTS_DIR: agentsB }).status).toBe(0);
  });
});

describe("㊶ codex AGENTS.md 同名：按 lock 哈希判定归属，只删自己的", () => {
  test("A rehome 不删 B 写入的 AGENTS.md（告警保留）；B verify 仍 0", () => {
    const h1 = mkdtempSync(join(tmpdir(), "dia-pa-codex-h1-"));
    const h2 = mkdtempSync(join(tmpdir(), "dia-pa-codex-h2-"));
    const idA = "codexowna", idB = "codexownb";

    const dirA = mkdtempSync(join(tmpdir(), `dia-pa-${idA}-`));
    mkdirSync(join(dirA, "agents"), { recursive: true });
    writeFileSync(join(dirA, "agents", `${idA}.md`), `---\ndescription: ${idA}\n---\nA\n`);
    writeFileSync(join(dirA, "AGENTS.md"), "A codex\n");
    writeFileSync(join(dirA, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: idA, version: "0.1.0",
      hosts: ["opencode", "codex"],
      entry: { opencode: `agents/${idA}.md`, codex: "AGENTS.md" },
      data_root: `~/.${idA}-agent`, access: { read: true },
    }));

    const dirB = mkdtempSync(join(tmpdir(), `dia-pa-${idB}-`));
    writeFileSync(join(dirB, "AGENTS.md"), "B codex\n");
    writeFileSync(join(dirB, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: idB, version: "0.1.0",
      hosts: ["codex"], entry: { codex: "AGENTS.md" },
    }));

    const agentsA = join(data, "agents-A5");
    mkdirSync(agentsA, { recursive: true });
    expect(run(["persona", "add", idA, "--from", dirA], { DIA_CODEX_HOME: h1, DIA_OPENCODE_AGENTS_DIR: agentsA }).status).toBe(0);
    expect(run(["persona", "add", idB, "--from", dirB, "--host", "codex", "--force"], { DIA_CODEX_HOME: h1 }).status).toBe(0);

    const agA = join(h1, ".codex", "AGENTS.md");
    expect(readFileSync(agA, "utf8")).toBe("B codex\n");

    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-own-"));
    const agentsA2 = join(data, "agents-A6");
    mkdirSync(agentsA2, { recursive: true });
    const r = run(["persona", "render", idA, "--rehome"], { DIA_HOME: home2, DIA_CODEX_HOME: h2, DIA_OPENCODE_AGENTS_DIR: agentsA2 });
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("疑似非本 persona 产物");
    expect(existsSync(agA)).toBe(true);
    expect(readFileSync(agA, "utf8")).toBe("B codex\n");
    expect(run(["persona", "verify", idB], { DIA_CODEX_HOME: h1 }).status).toBe(0);
  });
});

describe("㊸ codex 共享 home + 字节相同的 AGENTS.md：按「其它 persona 引用」保留，不误删", () => {
  test("A render --rehome：文件仍在、renderedRetired=kept-shared；A/B verify 均 0", () => {
    const h1 = mkdtempSync(join(tmpdir(), "dia-pa-share-h1-"));
    const h2 = mkdtempSync(join(tmpdir(), "dia-pa-share-h2-"));
    const idA = "codesharea", idB = "codeshareb";
    const same = "# shared codex\n\nsame bytes for A and B\n";

    const dirA = mkdtempSync(join(tmpdir(), `dia-pa-${idA}-`));
    mkdirSync(join(dirA, "agents"), { recursive: true });
    writeFileSync(join(dirA, "agents", `${idA}.md`), `---\ndescription: ${idA}\n---\nA\n`);
    writeFileSync(join(dirA, "AGENTS.md"), same);
    writeFileSync(join(dirA, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: idA, version: "0.1.0",
      hosts: ["opencode", "codex"],
      entry: { opencode: `agents/${idA}.md`, codex: "AGENTS.md" },
      data_root: `~/.${idA}-agent`, access: { read: true },
    }));

    const dirB = mkdtempSync(join(tmpdir(), `dia-pa-${idB}-`));
    writeFileSync(join(dirB, "AGENTS.md"), same);
    writeFileSync(join(dirB, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id: idB, version: "0.1.0",
      hosts: ["codex"], entry: { codex: "AGENTS.md" },
    }));

    expect(run(["persona", "add", idA, "--from", dirA], { DIA_CODEX_HOME: h1 }).status).toBe(0);
    // 字节完全相同 ⇒ 不算冲突，B 无需 --force 就覆盖了同一个 AGENTS.md
    expect(run(["persona", "add", idB, "--from", dirB], { DIA_CODEX_HOME: h1 }).status).toBe(0);
    const agA = join(h1, ".codex", "AGENTS.md");
    expect(readFileSync(agA, "utf8")).toBe(same);

    const home2 = mkdtempSync(join(tmpdir(), "dia-pa-h-share-"));
    const agentsA2 = join(data, "agents-share2");
    mkdirSync(agentsA2, { recursive: true });
    const r = run(["persona", "render", idA, "--rehome"], { DIA_HOME: home2, DIA_CODEX_HOME: h2, DIA_OPENCODE_AGENTS_DIR: agentsA2 });
    if (r.status !== 0) console.error(r.stdout, r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`其它 persona（${idB}）引用`);
    // 归属判定第二道：虽哈希一致，但 B 还引用它 → 保留，不备份不删
    expect(existsSync(agA)).toBe(true);
    expect(readFileSync(agA, "utf8")).toBe(same);
    expect(readFileSync(join(h2, ".codex", "AGENTS.md"), "utf8")).toBe(same);

    const lockA = JSON.parse(readFileSync(lockOf(idA, "0.1.0+local"), "utf8"));
    expect(lockA.rendered).not.toContain(agA);
    expect(lockA.renderedHashes[agA]).toBeUndefined();
    const retired = lockA.renderedRetired.find((e: any) => e && typeof e === "object" && e.path === agA);
    expect(retired?.kept).toBe("kept-shared");
    expect(retired?.by).toBe(idB);

    expect(run(["persona", "verify", idA], { DIA_HOME: home2, DIA_CODEX_HOME: h2, DIA_OPENCODE_AGENTS_DIR: agentsA2 }).status).toBe(0);
    expect(run(["persona", "verify", idB], { DIA_CODEX_HOME: h1 }).status).toBe(0);
  });
});

describe("㊷ 坏 lock + 后续安装失败：lock 不离开原位，可恢复后 remove 干净", () => {
  test("dsh profile 非 dia 管理 → 32 且 lock 原样；修复后 add --force 成功，remove 回收干净", () => {
    const id = "halful";
    const dir = mkdtempSync(join(tmpdir(), `dia-pa-${id}-`));
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "platform", "dsh", "p"), { recursive: true });
    writeFileSync(join(dir, "agents", `${id}.md`), `---\ndescription: ${id}\n---\nbody\n`);
    writeFileSync(join(dir, "platform", "dsh", "p", "cordis.yml"), "[]\n");
    writeFileSync(join(dir, "dia.json"), JSON.stringify({
      schema: 1, kind: "persona", id, version: "0.1.0",
      hosts: ["opencode", "dsh"],
      entry: { opencode: `agents/${id}.md`, dsh: "platform/dsh/p" },
      data_root: `~/.${id}-agent`, access: { read: true },
    }));
    expect(run(["persona", "add", id, "--from", dir]).status).toBe(0);

    const idDir = idDirOf(id);
    const slot = readdirSync(idDir).find((n) => n.startsWith("0.1.0"))!;
    const lockP = lockOf(id, slot);
    const profile = join(data, "dsh-profiles", id);
    // 让 dsh profile 变成「非 dia 管理」，并把 target slot 的 lock 弄坏
    rmSync(join(profile, ".dia-managed"), { force: true });
    writeFileSync(lockP, "{bad");

    const bad = run(["persona", "add", id, "--from", dir, "--force"]);
    expect(bad.status).toBe(32);
    expect(bad.stderr).toContain("E_CONFLICT");
    // 关键：坏 lock 没有被提前移走（原文件原样留在原位），remove/重装都还有依据
    expect(readFileSync(lockP, "utf8")).toBe("{bad");

    // 修复后重装 → 成功；再 remove 能完整回收 agent md
    writeFileSync(join(profile, ".dia-managed"), JSON.stringify({ id, version: "0.1.0" }));
    const ok = run(["persona", "add", id, "--from", dir, "--force"]);
    if (ok.status !== 0) console.error(ok.stdout, ok.stderr);
    expect(ok.status).toBe(0);
    expect(run(["persona", "verify", id]).status).toBe(0);

    const rm = run(["persona", "remove", id]);
    expect(rm.status).toBe(0);
    expect(existsSync(agentDest(id))).toBe(false);
    expect(existsSync(idDir)).toBe(false);
  });
});
