import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { helpGate, helpRequested } from "../packages/cli/src/help.ts";

// issue #228：子命令级 --help 必须「打印用法、不执行」。
// 真实事故：`dia job uninstall --help` 真的执行了 uninstall。
//
// 沙箱：每个用例独立 HOME/DIA_ROOT/DIA_JOB_ROOT/DIA_WT_REPOS_ROOT，
// 副作用判定用 node fs 递归快照（路径 + 类型 + size + mtimeMs），不依赖 find -printf（macOS 不支持）。

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "packages", "cli", "src", "index.ts");

interface Sandbox { dir: string; env: Record<string, string> }

/** 只保留与「路径/身份」无关的宿主变量；其余 DIA_ / XDG_ 一律不继承。
 *  为什么：`bun test` 同一进程内其它用例会留下 `DIA_STATE_DIR`/`DIA_DATA_DIR` 等
 *  （audit.test.ts 实测），子进程会读它们 ⇒ 沙箱被绕过（曾出现「frozen: test」串味）。 */
const HOST_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "USER", "LOGNAME", "TMPDIR", "TZ", "SystemRoot"];

/** 用例建的沙箱目录（跑完统一删）：本文件用例多，不清理会把 /tmp（tmpfs）吃满。 */
const SANDBOXES: string[] = [];
afterAll(() => {
  for (const d of SANDBOXES) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "dia-help-"));
  SANDBOXES.push(dir);
  const home = join(dir, "home");
  const data = join(dir, "data");
  const job = join(dir, "job");
  const repos = join(dir, "repos");
  for (const d of [home, data, job, join(job, "tasks"), repos]) mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {};
  for (const k of HOST_ENV) if (process.env[k] !== undefined) env[k] = String(process.env[k]);
  env.HOME = home;
  env.DIA_ROOT = data;
  env.DIA_JOB_ROOT = job;
  env.DIA_JOB_NO_LAUNCHD = "1";
  env.DIA_WT_REPOS_ROOT = repos;
  env.DIA_SESSION_ID = "ses_help_test";
  env.NO_COLOR = "1";
  // bun 自己的全局安装缓存也会落到 $HOME（与 dia 无关），挪出沙箱，避免污染副作用快照
  env.BUN_INSTALL = join(tmpdir(), "dia-help-bun-install");
  return { dir, env };
}

function run(sb: Sandbox, args: string[], cwd = ROOT) {
  return spawnSync("bun", [CLI, ...args], {
    cwd,
    env: sb.env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** 递归快照：路径 + 类型 + size + mtimeMs（毫秒取整，避免一跑就抖）。
 *  跳过 `/.bun/`、`/.cache/`：那是 **bun 运行时自己的缓存**（与 dia 无关），
 *  不是被测命令的副作用；不跳过会在每个用例里引入噪声差异。 */
function snapshot(dir: string): string[] {
  const rows: string[] = [];
  const walk = (p: string) => {
    let ents;
    try { ents = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".bun" || e.name === ".cache") continue;
      const full = join(p, e.name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
      rows.push(`${full}\t${kind}\t${st.size}\t${Math.round(st.mtimeMs)}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return rows.sort();
}

/** 帮助横幅的最低信息量判据：够长 + 是这条命令的用法。
 *  （msg 的正文是逐字搬迁的旧帮助，没有 "usage:" 字样，故同时接受命令名出现。） */
function hasHelp(s: string, cmd: string): boolean {
  return s.trim().length > 60 && (/usage|用法/i.test(s) || s.includes(`dia ${cmd}`));
}

/** 吞掉一段 stdout（helpGate 命中时会打印帮助；单测里不想污染测试输出）。 */
function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as any).write = (chunk: any) => { buf += String(chunk); return true; };
  try { fn(); } finally { (process.stdout as any).write = orig; }
  return buf;
}

// ── 单元：helpRequested / helpGate 的判定表 ────────────────────────────────
describe("helpRequested 值位判定", () => {
  test("裸 --help / -h 算请求帮助", () => {
    expect(helpRequested(["--help"])).toBe(true);
    expect(helpRequested(["-h"])).toBe(true);
    expect(helpRequested(["install", "--help"])).toBe(true);
  });

  test("值位：取值 flag 后面的 --help 是值", () => {
    expect(helpRequested(["--body", "--help"])).toBe(false);
    expect(helpRequested(["--desc", "--help", "--cmd", "x"])).toBe(false);
    expect(helpRequested(["--subject", "s", "--body", "--help", "--json"])).toBe(false);
  });

  test("--x=--help（attached）不算", () => {
    expect(helpRequested(["--body=--help"])).toBe(false);
  });

  test("`--` 之后全是数据", () => {
    expect(helpRequested(["--", "--help"])).toBe(false);
    expect(helpRequested(["--session", "s", "--", "echo", "--help"])).toBe(false);
  });

  test("拿不准（未知 flag 在前）⇒ 当帮助（fail-safe）", () => {
    expect(helpRequested(["--some-unknown-flag", "--help"])).toBe(true);
  });

  test("helpGate：job/wt 走各自通路，不在通用 gate 里拦", () => {
    expect(helpGate("job", ["--help"])).toBeNull();
    expect(helpGate("wt", ["--help"])).toBeNull();
  });

  test("helpGate：透传命令只在第一个参数是 help 时拦", () => {
    const out = captureStdout(() => expect(helpGate("run", ["--help"])).toBe(0));
    expect(out).toContain("dia run");
    captureStdout(() => expect(helpGate("cmd", ["--help"])).toBe(0));
    expect(helpGate("run", ["--session", "s", "--", "echo", "--help"])).toBeNull();
    expect(helpGate("env", ["ls", "--help"])).toBeNull();
  });
});

// ── 正向：每个命令的 --help 都打印用法且 exit 0 ────────────────────────────
describe("dia <cmd> --help → 打印用法、exit 0", () => {
  const CMDS = [
    "kb", "ingest", "audit", "freeze", "guard", "run", "resume", "persona", "doctor", "deps",
    "cache", "env", "kit", "service", "cmd", "collab", "whoami", "in", "out", "ack", "reply",
    "close", "show", "msg", "agents", "team", "job", "price", "version", "update", "postinstall",
    "migrate", "graph", "task", "wb", "beat", "claim", "claims", "unclaim", "wt",
  ];

  for (const cmd of CMDS) {
    test(`dia ${cmd} --help`, () => {
      const sb = sandbox();
      const r = run(sb, [cmd, "--help"]);
      expect(r.status).toBe(0);
      expect(hasHelp(r.stdout, cmd)).toBe(true);
    });
  }
});

// ── 核心：破坏性命令 --help 必须「零副作用」 ──────────────────────────────
// 三连断言：exit 0 + 输出是帮助 + 沙箱快照全等。
const DESTRUCTIVE: Array<{ name: string; args: (sb: Sandbox) => string[] }> = [
  { name: "job uninstall", args: () => ["job", "uninstall", "some-task", "--help"] },
  { name: "job install", args: () => ["job", "install", "t1", "--cmd", "echo hi", "--help"] },
  { name: "job gc", args: () => ["job", "gc", "--help"] },
  { name: "job migrate", args: (sb) => ["job", "migrate", "--from", join(sb.dir, "old-job"), "--help"] },
  { name: "job bootstrap", args: () => ["job", "bootstrap", "--help"] },
  { name: "job registry gc", args: () => ["job", "registry", "gc", "--apply", "--help"] },
  { name: "wt clean", args: (sb) => ["wt", "clean", join(sb.dir, "repos", "r1"), "feat-x", "--help"] },
  { name: "wt prune-merged --apply", args: () => ["wt", "prune-merged", "--apply", "--help"] },
  { name: "wt create", args: (sb) => ["wt", "create", join(sb.dir, "repos", "r1"), "feat-x", "--help"] },
  { name: "kit remove", args: () => ["kit", "remove", "k1", "--help"] },
  { name: "service remove", args: () => ["service", "remove", "s1", "--help"] },
  { name: "persona remove", args: () => ["persona", "remove", "p1", "--help"] },
  { name: "persona gc", args: () => ["persona", "gc", "p1", "--help"] },
  { name: "cache gc --apply", args: () => ["cache", "gc", "--apply", "--help"] },
  { name: "unclaim --force", args: () => ["unclaim", "some/path", "--force", "--help"] },
  { name: "collab disable", args: () => ["collab", "disable", "--help"] },
  { name: "team accept --merge", args: () => ["team", "accept", "t-1", "--merge", "--help"] },
  { name: "update", args: () => ["update", "--help"] },
  { name: "wb gc --apply", args: () => ["wb", "gc", "--apply", "--help"] },
  { name: "in", args: () => ["in", "--help"] },
  { name: "msg close", args: () => ["msg", "close", "m-1", "--help"] },
];

const ACTION_MARKERS = /REMOVED|removed|accepted|closed|disabled|released/;

describe("破坏性命令 --help：零副作用 + 不打印动作标记", () => {
  for (const c of DESTRUCTIVE) {
    test(`dia ${c.name} --help`, () => {
      const sb = sandbox();
      // 预热：让 bun 运行时把自身缓存（$HOME/.bun 等）建好，再拍「前」快照；
      // 否则第一次 spawn 会改 $HOME 的 mtime，产生与被测命令无关的差异。
      run(sb, ["version"]);
      const before = snapshot(sb.dir);
      const r = run(sb, c.args(sb));
      const after = snapshot(sb.dir);
      expect(r.status).toBe(0);
      expect(hasHelp(r.stdout, c.args(sb)[0])).toBe(true);
      expect(r.stdout).not.toMatch(ACTION_MARKERS);
      expect(after).toEqual(before);
    });
  }
});

// ── 负例：值位 / 透传不能被误当成 help ────────────────────────────────────
describe("值位与透传：--help 是数据，不是请求", () => {
  test("msg send --body --help 真发消息，正文是 --help", () => {
    const sb = sandbox();
    const r = run(sb, ["msg", "send", "ses_x", "--subject", "s", "--body", "--help", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("dia msg send");
    const m = JSON.parse(r.stdout);
    expect(m.body).toBe("--help");
    expect(m.id).toMatch(/^m-/);
  });

  test("msg send --body=--help 不被当成 help（仍走发送路径）", () => {
    // 注：msg send 目前不解析 `--flag=value` 写法（既有行为，未在本次改动），
    //     所以正文为空；本用例只保证 #228 的语义 —— **不打印帮助、不拦发送**。
    const sb = sandbox();
    const r = run(sb, ["msg", "send", "ses_x", "--subject", "s", "--body=--help", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("dia msg send");
    const m = JSON.parse(r.stdout);
    expect(m.id).toMatch(/^m-/);
  });

  test("run 透传：`-- echo --help` 里的 --help 给 echo", () => {
    const sb = sandbox();
    const r = run(sb, ["run", "--session", "ses_x", "--", "echo", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("dia run");
  });

  test("env 透传：`env ls --help` 不输出 dia 的 env 帮助", () => {
    const sb = sandbox();
    const r = run(sb, ["env", "ls", "--help"]);
    expect(r.stdout).not.toContain("usage: dia env");
    expect(r.stdout).not.toContain("dia env list|check");
  });

  test("freeze --reason --help：真的以 reason='--help' 冻结（沙箱内）", () => {
    const sb = sandbox();
    const r = run(sb, ["freeze", "--reason", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("frozen: --help");
    const st = run(sb, ["freeze", "status"]);
    expect(st.stdout).toContain("--help");
  });
});

// ── 事故回归：`dia job --help` 退出码 2 → 0 ────────────────────────────────
describe("dia job --help 退出码", () => {
  test("exit 0 且打印用法（修复前是 2）", () => {
    const sb = sandbox();
    const r = run(sb, ["job", "--help"]);
    expect(r.status).toBe(0);
    expect(hasHelp(r.stdout, "job")).toBe(true);
  });
});

// ── 追补（2026-11-19 对抗评审）：`env` 的透传判定要细化 ──────────────────────
// 事故：`dia env bw serve --help` 真的起了常驻 broker（`env` 在透传名单里，
// probe 只看第一个 token 是不是 `bw` ⇒ 整个 bw 家族被放过）。
// 但 `env bw` 是 dia 自己的子命令，不是透传给系统的命令 ⇒ 必须拦。
describe("dia env bw … --help：dia 自己的 bw 子命令必须只打印用法", () => {
  test("env bw serve --help 不启动 broker（无 broker listening / 退出码 0）", () => {
    const sb = sandbox();
    run(sb, ["version"]); // 预热 bun 缓存，再拍快照
    const before = snapshot(sb.dir);
    const r = run(sb, ["env", "bw", "serve", "--help"]);
    const after = snapshot(sb.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dia env bw");
    expect(r.stdout).not.toContain("broker listening");
    expect(after).toEqual(before);
  });

  test("env bw unlock --help 不走解锁路径", () => {
    const sb = sandbox();
    const r = run(sb, ["env", "bw", "unlock", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dia env bw");
    expect(r.stdout).not.toContain("unlocked");
  });

  test("env bw 的其余 action 也走同一条闸（get/lock/status/run）", () => {
    for (const act of ["get", "lock", "status", "run"]) {
      const sb = sandbox();
      const r = run(sb, ["env", "bw", act, "--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("dia env bw");
    }
  });

  test("透传仍然透传：env ls --help 交给系统的 ls", () => {
    const sb = sandbox();
    const r = run(sb, ["env", "ls", "--help"]);
    expect(r.stdout).not.toContain("dia env bw");
    expect(r.stdout).not.toContain("用法: dia env");
  });

  test("env --dry-run <cmd> --help：--help 属于系统命令，不属于 dia", () => {
    const sb = sandbox();
    const r = run(sb, ["env", "--dry-run", "ls", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("将注入");
    expect(r.stdout).not.toContain("dia env bw");
  });
});

// ── 追补：白名单**误收** ⇒ 命令照常执行（评审复现时真的删了数据）───────────
// `--force-with-lease` 零消费方却被收进 VALUE_FLAGS ⇒ 紧跟的 --help 被当值吞掉。
describe("值位白名单误收回归（--force-with-lease）", () => {
  test("cache gc --apply --force-with-lease --help 不删任何文件", () => {
    const sb = sandbox();
    const victim = join(sb.dir, "data", "cache", "src", "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "f"), "x");
    run(sb, ["version"]); // 预热
    const before = snapshot(sb.dir);
    const r = run(sb, ["cache", "gc", "--apply", "--force-with-lease", "--help"]);
    const after = snapshot(sb.dir);
    expect(r.status).toBe(0);
    expect(hasHelp(r.stdout, "cache")).toBe(true);
    expect(r.stdout).not.toContain("已删除");
    expect(existsSync(join(victim, "f"))).toBe(true);
    expect(after).toEqual(before);
  });

  test("跨命令形态：cache gc --apply --<其它命令的取值 flag> --help 也一律当帮助", () => {
    // 白名单是全局的；若任何取值 flag 都能吃掉 --help，则 `--id --help` 会变成真删。
    const sb = sandbox();
    const victim = join(sb.dir, "data", "cache", "src", "victim2");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "f"), "y");
    for (const f of ["--id", "--item", "--session", "--workspace", "--timeout"]) {
      const r = run(sb, ["cache", "gc", "--apply", f, "--help"]);
      expect(r.status).toBe(0);
      expect(hasHelp(r.stdout, "cache")).toBe(true);
      expect(existsSync(join(victim, "f"))).toBe(true);
    }
  });
});

// ── 追补：`dia wt <sub> --help` 对 form/route/scope/gate/guard/doctor 无效 ──
// 评审实测 form 真算选型、gate 真跑 check+doctor、guard 零输出 exit 0、doctor 报未知参数…
describe("dia wt <sub> --help → exit 0 + 有用法（6 个子命令）", () => {
  const WT_BIN = join(ROOT, "packages", "wt", "bin", "dia-wt");
  const SUBS = ["form", "route", "scope", "gate", "guard", "doctor"];
  for (const sub of SUBS) {
    test(`wt ${sub} --help`, () => {
      const sb = sandbox();
      const r = spawnSync("bash", [WT_BIN, sub, "--help"], {
        cwd: sb.dir,
        env: { ...sb.env, DIA_WT_DATA_ROOT: join(sb.dir, "wtd") },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`dia wt ${sub}`);
      expect(r.stderr).toBe("");
    });
  }

  test("wt gate <repo> <feat> --help 不真跑 check+doctor", () => {
    const sb = sandbox();
    const r = spawnSync("bash", [WT_BIN, "gate", join(sb.dir, "repos", "nope"), "feat-x", "--help"], {
      cwd: sb.dir,
      env: { ...sb.env, DIA_WT_DATA_ROOT: join(sb.dir, "wtd") },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("== check");
    expect(r.stdout).not.toContain("gate FAIL");
  });
});

// ── 追补：5 条帮助文本的机械重复后缀 ────────────────────────────────────────
describe("帮助文本没有重复后缀", () => {
  const KEYS = ["agents list", "agents unregister", "task list", "task plan", "task done"];
  for (const key of KEYS) {
    test(`dia ${key} --help`, () => {
      const sb = sandbox();
      const r = run(sb, [...key.split(" "), "--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain("（完整参数见 dia --help）（完整参数见 dia --help）");
      expect(r.stdout.split("（完整参数见 dia --help）").length - 1).toBeLessThanOrEqual(1);
    });
  }
});
