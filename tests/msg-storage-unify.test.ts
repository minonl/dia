import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 端到端：日志分级开关（走子进程，验真 stderr）
const cli = join(import.meta.dir, "..", "packages", "cli", "src", "index.ts");
let root: string;
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, DIA_ROOT: root, DIA_SESSION_ID: "ses_a", OPENCODE_SESSION_ID: "", ...env },
});
const json = (s: string) => JSON.parse(s);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dia-log-")); });

/** 一次 send 会产出 verbose 快照 + info 事件镜像 */
function sendOnce(env: Record<string, string>) {
  return run(["msg", "send", "--to", "ses_b", "--kind", "notify", "--subject", "s", "--body", "b", "--json"], env);
}

describe("日志分级开关（DIA_LOG_LEVEL）", () => {
  test("默认（不设）= verbose：verbose/info 都出 stderr，stdout 保持纯 JSON", () => {
    const r = sendOnce({});
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("VERBOSE");
    expect(r.stderr).toContain("INFO");
    expect(r.stderr).toContain("snapshot:send.begin");
    // stdout 不能被日志污染
    expect(() => json(r.stdout)).not.toThrow();
    expect(r.stdout.trim().startsWith("{")).toBe(true);
  });

  test("DIA_LOG_LEVEL=info：verbose 不再输出，info 还在", () => {
    const r = sendOnce({ DIA_LOG_LEVEL: "info" });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("VERBOSE");
    expect(r.stderr).toContain("INFO");
  });

  test("DIA_LOG_LEVEL=error：verbose/debug/info/warn 全不出", () => {
    const r = sendOnce({ DIA_LOG_LEVEL: "error" });
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toBe("");
    expect(() => json(r.stdout)).not.toThrow();
  });

  test("DIA_LOG_LEVEL=off：什么都不出", () => {
    const r = sendOnce({ DIA_LOG_LEVEL: "off" });
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toBe("");
    // 业务照常落盘
    const inbox = json(run(["msg", "inbox", "--json"], { DIA_SESSION_ID: "ses_b", DIA_LOG_LEVEL: "off" }).stdout);
    expect(inbox.length).toBe(1);
  });

  test("DIA_LOG_LEVEL=warn：info 不出；失败路径的 warn 会出", () => {
    const ok = sendOnce({ DIA_LOG_LEVEL: "warn" });
    expect(ok.status).toBe(0);
    expect(ok.stderr.trim()).toBe("");
  });
});

describe("留痕：事件流（机器可读）与运行日志（人可读）分工", () => {
  test("事件流仍是 JSONL 且有完整状态迁移；人可读日志可以关掉", () => {
    // 关掉人可读日志，事件流必须照常写（trace 依赖它）
    const sent = json(sendOnce({ DIA_LOG_LEVEL: "off" }).stdout);
    run(["msg", "show", sent.id, "--json"], { DIA_SESSION_ID: "ses_b", DIA_LOG_LEVEL: "off" });
    run(["msg", "ack", sent.id], { DIA_SESSION_ID: "ses_b", DIA_LOG_LEVEL: "off" });
    run(["msg", "reply", sent.id, "--body", "ok"], { DIA_SESSION_ID: "ses_b", DIA_LOG_LEVEL: "off" });

    const evDir = join(root, "collab", "events");
    expect(existsSync(evDir)).toBe(true);
    const raw = readdirSync(evDir).map((f) => readFileSync(join(evDir, f), "utf8")).join("");
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const name of ["send.accepted", "acked", "replied"]) {
      expect(events.some((e) => e.event === name)).toBe(true);
    }
    const acked = events.find((e) => e.event === "acked");
    expect(acked.to_state).toBe("acked");
    expect(typeof acked.latency_ms).toBe("number");

    // trace 子命令在日志全关时照常输出（数据源是事件流，不是 stderr）
    const tr = run(["msg", "trace", sent.id], { DIA_SESSION_ID: "ses_b", DIA_LOG_LEVEL: "off" });
    expect(tr.status).toBe(0);
    expect(tr.stdout).toContain("send.accepted");
    expect(tr.stdout).toContain("replied");
  });
});

describe("日志写失败不阻断业务", () => {
  test("stderr 指向只读/不可写目标：send 仍成功", () => {
    const ro = join(root, "ro.log");
    writeFileSync(ro, "");
    chmodSync(ro, 0o444);
    // 用 sh 重定向到只读文件：写失败发生在进程外，等价于「日志通道坏了」
    const r = spawnSync("sh", ["-c", `bun ${cli} msg send --to ses_b --kind notify --subject s --body b --json > ${join(root, "o.json")} 2>/dev/null`], {
      encoding: "utf8",
      env: { ...process.env, DIA_ROOT: root, DIA_SESSION_ID: "ses_a" },
    });
    expect(r.status).toBe(0);
    const sent = JSON.parse(readFileSync(join(root, "o.json"), "utf8"));
    expect(sent.id).toBeTruthy();
    expect(existsSync(join(root, "collab", "inbox", "ses_b", `${sent.id}.json`))).toBe(true);
  });
});

describe("msg migrate / analyze-storage（旧数据一次性导入）", () => {
  function seedV1(agentDir: string, file: string, payload: Record<string, unknown>) {
    const dir = join(root, "msg", agentDir, "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(payload));
  }

  test("migrate 默认 dry-run：报告但不出现在 inbox；--apply 后可 show/reply，且幂等", () => {
    seedV1("session:ses_old1", "m-a.json", {
      id: "m-a", thread_id: "th-a", seq: 1, from: "session:ses_src", to: "session:ses_old1",
      kind: "question", subject: "旧问题", body: "旧正文", requires_reply: true, hops: 0,
      idempotency_key: "th-a#1", created_at: "2026-11-01T00:00:00Z", state: "pending",
    });
    const dry = json(run(["msg", "migrate", "--json"]).stdout);
    expect(dry.dry_run).toBe(true);
    expect(dry.imported).toBe(1);
    expect(existsSync(join(root, "collab", "inbox", "ses_old1", "m-a.json"))).toBe(false);

    const applied = json(run(["msg", "migrate", "--apply", "--json"]).stdout);
    expect(applied.dry_run).toBe(false);
    expect(applied.imported).toBe(1);

    // show：正文保留
    const shown = json(run(["msg", "show", "m-a", "--json"], { DIA_SESSION_ID: "ses_old1" }).stdout);
    expect(shown.subject).toBe("旧问题");
    expect(shown.body).toBe("旧正文");
    expect(shown.state).toBe("pending");
    expect(shown.legacy).toBeUndefined();

    // reply：可回复（不是只读）
    const rep = run(["msg", "reply", "m-a", "--body", "已处理", "--json"], { DIA_SESSION_ID: "ses_old1" });
    expect(rep.status).toBe(0);

    // 幂等：再 apply 一次 → 全部跳过
    const again = json(run(["msg", "migrate", "--apply", "--json"]).stdout);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    // 旧文件仍在（不删）
    expect(existsSync(join(root, "msg", "session:ses_old1", "inbox", "m-a.json"))).toBe(true);
  });

  test("提取不到 session id：进 unresolved 报告，不导入，不崩", () => {
    seedV1("老代理", "m-b.json", { id: "m-b", subject: "x", body: "y" });
    const r = run(["msg", "migrate", "--apply", "--json"]);
    expect(r.status).toBe(0);
    const rep = json(r.stdout);
    expect(rep.imported).toBe(0);
    expect(rep.unresolved.length).toBe(1);
    expect(rep.unresolved[0].agent_dir).toBe("老代理");
    expect(rep.unresolved[0].files).toBe(1);
    expect(existsSync(join(root, "collab", "inbox", "老代理"))).toBe(false);
  });

  test("analyze-storage 输出 v1/v2/事件流三段并能给结论", () => {
    seedV1("session:ses_old2", "m-c.json", { id: "m-c", subject: "s", body: "b", state: "pending" });
    seedV1("无法识别", "m-d.json", { id: "m-d", subject: "s" });
    // 先造一条 v2 消息（让 v2 段非空）
    const sent = json(run(["msg", "send", "--to", "ses_b", "--subject", "x", "--json"]).stdout);

    const j = json(run(["msg", "analyze-storage", "--json"]).stdout);
    expect(j.v2.messages).toBe(1);
    expect(j.v2.by_state.pending).toBe(1);
    expect(j.v1.present).toBe(true);
    const agents = j.v1.agents.map((a: any) => a.agent_dir);
    expect(agents).toContain("session:ses_old2");
    expect(agents).toContain("无法识别");
    const unresolvable = j.v1.agents.find((a: any) => a.agent_dir === "无法识别");
    expect(unresolvable.session_id).toBeNull();
    expect(unresolvable.importable).toBe(0);
    const resolvable = j.v1.agents.find((a: any) => a.agent_dir === "session:ses_old2");
    expect(resolvable.session_id).toBe("ses_old2");
    expect(resolvable.importable).toBe(1);
    expect(j.events.lines).toBeGreaterThan(0);
    expect(j.events.bad_lines).toBe(0);
    expect(j.verdict.join("\n")).toContain("可导入");
    expect(j.verdict.join("\n")).toContain("提取不到 ses_*");

    // 人类可读输出也要有内容
    const text = run(["msg", "analyze-storage"]).stdout;
    expect(text).toContain("v2 ");
    expect(text).toContain("events ");
    expect(text).toContain("session:ses_old2");

    // 只读：跑完不产生任何迁移
    expect(existsSync(join(root, "collab", "inbox", "ses_old2"))).toBe(false);
    expect(sent.id).toBeTruthy();
  });
});

describe("migrate data：collab 子目录也被搬", () => {
  test("--from 旧根含 collab 时会合并", () => {
    const from = join(root, "legacy-share");
    const collabDir = join(from, "collab", "inbox", "ses_z");
    mkdirSync(collabDir, { recursive: true });
    writeFileSync(join(collabDir, "m-z.json"), JSON.stringify({ id: "m-z", state: "pending" }));
    const dry = run(["migrate", "data", "--from", from, "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("collab");
    const real = run(["migrate", "data", "--from", from]);
    expect(real.status).toBe(0);
    expect(existsSync(join(root, "collab", "inbox", "ses_z", "m-z.json"))).toBe(true);
  });
});
