import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { get, status as setStatus } from "./task.ts";
import { AcpClient } from "./acp.ts";
import { costOf, loadPrices } from "./pricing.ts";
import { execFileSync } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";

const DATA = process.env.DIA_DATA_DIR || join(homedir(), ".local", "share", "dia");
const RUNS = join(DATA, "runs");

export function runDir(id: string) { return join(RUNS, id); }

export function runMock(id: string) {
  const t = get(id);
  const dir = runDir(id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.md"), `# Plan: ${t.title}\n\n- judge: ${t.judge || "(missing)"}\n- roles: planner → builder → verifier → redteam\n`);
  writeFileSync(join(dir, "diff.patch"), "# mock diff\n");
  writeFileSync(join(dir, "test.log"), "mock tests: 0 failures\n");
  writeFileSync(join(dir, "verify.json"), JSON.stringify({ conclusion: "通过", commit: "mock", evidence: ["mock test.log"] }, null, 1));
  writeFileSync(join(dir, "redteam.json"), JSON.stringify({ findings: [] }, null, 1));
  writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 结论：通过（mock）\n- 风险：无\n`);
  writeFileSync(join(dir, "run.json"), JSON.stringify({ mock: true, judge: t.judge || null, ts: new Date().toISOString() }, null, 1));
  setStatus(id, "awaiting_acceptance", "mock run");
  return dir;
}

/** redteam 的 high 级反驳：gate 必须拦住，run 要回灌给 builder 修。 */
export function highFindings(redteam: any): any[] {
  const list = Array.isArray(redteam?.findings) ? redteam.findings : [];
  return list.filter((f: any) => String(f?.severity || "").toLowerCase() === "high");
}

/** 在 workspace 里跑判据命令；返回退出码 + 合并输出（截断）。 */
function runJudge(workspace: string, judge: string) {
  const r = execFileSync("sh", ["-c", judge], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: 0, out: String(r) };
}

/** 同 runJudge，但把非 0 退出码当结果返回而不是抛异常。 */
function runJudgeSafe(workspace: string, judge: string): { code: number; out: string } {
  try {
    return runJudge(workspace, judge);
  } catch (e: any) {
    return { code: typeof e?.status === "number" ? e.status : 1, out: String(e?.stdout || e?.message || "") };
  }
}

/** 用量落盘（acp/dsh 两条驱动路径共用同一份 usage.json 结构）。 */
function writeUsage(dir: string, id: string, acc: { rows: any[]; input: number; output: number; total: number; cost: number; unpriced: number }) {
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: acc.rows.length, input_tokens: acc.input, output_tokens: acc.output, total_tokens: acc.total, cost_usd: acc.cost, unpriced_calls: acc.unpriced, by_role: acc.rows }, null, 1));
}

/** 判据在哪个 workspace 跑：以 run.json 为准（gate 也这么做），缺失才回退。 */
function judgeWorkspace(dir: string, fallback: string): string {
  try {
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    const ws = String(run?.workspace || "");
    if (ws) return ws;
  } catch {}
  return fallback;
}

export function gate(id: string) {
  const dir = runDir(id);
  const need = ["plan.md", "diff.patch", "test.log", "verify.json", "redteam.json", "packet.md", "run.json"];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) return { ok: false, reason: "missing: " + missing.join(",") };

  let verify: any, redteam: any, run: any;
  try { verify = JSON.parse(readFileSync(join(dir, "verify.json"), "utf8")); } catch { return { ok: false, reason: "bad verify.json" }; }
  try { redteam = JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8")); } catch { return { ok: false, reason: "bad redteam.json" }; }
  try { run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")); } catch { return { ok: false, reason: "bad run.json" }; }

  if (!["通过", "不通过", "无法判定"].includes(verify.conclusion)) return { ok: false, reason: "bad conclusion" };
  if (verify.conclusion !== "通过") return { ok: false, reason: "verify conclusion: " + verify.conclusion };
  if (!Array.isArray(verify.evidence) || !verify.evidence.length) return { ok: false, reason: "no evidence" };
  if (verify.evidence.some((e: any) => {
    const t = String(e).trim();
    return !t || t === "(no evidence)" || t === "invalid verifier output";
  })) return { ok: false, reason: "placeholder evidence" };
  if (!Array.isArray(redteam.findings)) return { ok: false, reason: "bad findings" };
  const high = highFindings(redteam);
  if (high.length) return { ok: false, reason: `redteam high: ${high.length}（必须先修复）` };

  // 判据：**以任务台账为准**，由 gate 现场重跑（workspace 从 run.json 取）。
  // 任何角色写过的 judge.json 都不采信——它只是上一次的观察记录，会被本次结果覆盖。
  const t = get(id);
  const judgeCmd = String(t.judge || "").trim();
  if (!judgeCmd) return { ok: false, reason: "task has no judge" };
  if (run.judge && String(run.judge) !== judgeCmd) {
    return { ok: false, reason: "run.json judge 与任务台账不一致（角色改过判据）" };
  }
  if (run.mock) {
    // mock 只用于状态机演练：不允许拿它当判据证据过 gate
    return { ok: false, reason: "mock run 不能作为验收证据（请用 --acp/--dsh 真跑判据）" };
  }
  const workspace = String(run.workspace || "");
  if (!workspace || !existsSync(workspace)) return { ok: false, reason: "run.json workspace 不存在" };

  const started = Date.now();
  let exit = 1, out = "";
  try {
    const r = execFileSync("sh", ["-c", judgeCmd], { cwd: workspace, encoding: "utf8", timeout: 600_000, maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    exit = 0;
    out = String(r);
  } catch (e: any) {
    exit = typeof e?.status === "number" ? e.status : 1;
    out = String(e?.stdout || e?.message || "");
  }
  writeFileSync(join(dir, "judge.json"), JSON.stringify({ source: "gate", command: judgeCmd, exit, ms: Date.now() - started, ts: new Date().toISOString() }, null, 1));
  writeFileSync(join(dir, "judge.log"), out.slice(0, 20000));
  if (exit !== 0) return { ok: false, reason: `judge exit: ${exit}（见 judge.log）` };
  return { ok: true };
}

export async function parseRoleJsonWithRepair(raw: string, retry: (msg: string) => Promise<string>): Promise<{ value: any; repaired: boolean }> {
  let text = raw;
  for (let i = 0; i <= 1; i++) {
    try {
      return { value: parseRoleJson(text), repaired: i > 0 };
    } catch (e: any) {
      if (i === 1) throw e;
      text = await retry(`Your previous output was not valid JSON (${e.message}). Return ONLY the JSON object, no prose/code fences. Previous output:\n${text.slice(0, 2000)}`);
    }
  }
  throw new Error("E_ROLE: unreachable");
}

function extractJsonObject(text: string): { body: string; offset: number } {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("E_ROLE: no json object (offset=-1)");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(start, i + 1), offset: start };
    }
  }
  throw new Error(`E_ROLE: unbalanced json object (offset=${start})`);
}

export function parseRoleJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const { body: json, offset } = extractJsonObject(body);
  const base = fence ? text.indexOf(fence[1]) : 0;
  try {
    return JSON.parse(json);
  } catch (e: any) {
    throw new Error(`E_ROLE: invalid JSON at offset ${base + offset} (${e.message}) near: ${json.slice(0, 80)}`);
  }
}

function recordModelCall(taskId: string, role: string, model: string | null, usage: any, acc: { rows: any[]; input: number; output: number; total: number; cost: number; unpriced: number }, prices: any) {
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  const reported = Number(usage?.totalTokens ?? input + output);
  const total = input + output;
  const c = costOf(model, usage, prices);
  const row = { ts: new Date().toISOString(), task_id: taskId, role, model, input_tokens: input, output_tokens: output, total_tokens: total, reported_total_tokens: reported, cost_usd: c.usd, priced: c.priced };
  acc.rows.push(row); acc.input += input; acc.output += output; acc.total += total;
  if (c.usd !== null) acc.cost += c.usd; else acc.unpriced++;
  mkdirSync(join(DATA, "runtime"), { recursive: true });
  appendFileSync(join(DATA, "runtime", "model-calls.jsonl"), JSON.stringify(row) + "\n");
}

const SENSITIVE = [
  "/.env", ".env.", "/.npmrc", "/.netrc", "/.pypirc", "/.docker/config.json",
  "/.git/config", "/.ssh/", "/.aws/", "/.gnupg/", ".pem", ".key", ".p12", ".keystore",
];

function isSensitive(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  return SENSITIVE.some((x) => norm.includes(x));
}

/** 快照目录放到 run 目录之外（系统临时目录），避免角色会话顺着相对路径摸到验收证据。 */
function snapPath(id: string, dir: string, tag: string): string {
  const p = join(tmpdir(), `dia-team-${id}-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const f = join(dir, "snapshots.json");
  let list: string[] = [];
  try { list = JSON.parse(readFileSync(f, "utf8")); } catch { list = []; }
  list.push(p);
  writeFileSync(f, JSON.stringify(list, null, 1));
  return p;
}

export function snapshotWorkspace(src: string, dest: string): string {
  if (resolve(dest).startsWith(resolve(src) + "/")) throw new Error("E_SNAPSHOT: dest inside src");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (p: string) => !p.split("/").includes("node_modules") && !isSensitive(p),
  });
  return dest;
}

export function cleanupSnapshots(runDir: string) {
  if (process.env.DIA_KEEP_SNAPSHOTS === "1") return;
  // 新路径（run 目录之外）：按 snapshots.json 登记清理
  try {
    for (const p of JSON.parse(readFileSync(join(runDir, "snapshots.json"), "utf8")) as string[]) {
      if (resolve(p).startsWith(resolve(tmpdir()) + "/")) rmSync(p, { recursive: true, force: true });
    }
    rmSync(join(runDir, "snapshots.json"), { force: true });
  } catch { /* 没有登记就跳过 */ }
  // 兼容旧 run：以前快照就在 run 目录里
  for (const e of readdirSync(runDir)) {
    if (e.startsWith("verify-ws-") || e === "redteam-ws" || e.startsWith("redteam-ws-")) rmSync(join(runDir, e), { recursive: true, force: true });
  }
}

/**
 * redteam high 回灌修复闭环（acp/dsh 两条驱动路径共用）。
 * 修完复跑判据（workspace 取自 run.json）+ 再复检一轮；仍不达标就升级——判据只有这一份。
 */
async function repairRedteamHighs(o: {
  id: string;
  dir: string;
  task: any;
  workspace: string;
  judge: string;
  redteam: any;
  usageAcc: { rows: any[]; input: number; output: number; total: number; cost: number; unpriced: number };
  builderFix: (findings: any[]) => Promise<void>;
  round2: (ws: string, diff: string) => Promise<{ value: any; repaired: boolean }>;
}): Promise<{ redteam: any; escalated: boolean }> {
  const { id, dir, task: t, judge, usageAcc } = o;
  let redteam = o.redteam;
  const high = highFindings(redteam);
  if (!high.length) return { redteam, escalated: false };

  // 1) 把 high 发现回灌 builder 修（提示词与 ACP 路径一致：保持判据绿，不许改判据）
  await o.builderFix(high);

  // 2) 复跑判据（不采信角色自述）
  const workspace = judgeWorkspace(dir, o.workspace);
  const jr = runJudgeSafe(workspace, judge);
  writeFileSync(join(dir, "test.log"), `judge: ${judge}\nexit=${jr.code}\n${jr.out}`.slice(0, 20000));

  // 3) builder-fix 的真实改动必须写回验收包：packet.md 只写「变更：见 diff.patch」，
  //    diff.patch 停在修复前 = 人对不含修复的 diff 拍板（acp/dsh 两条路径共用此处）。
  const diff2 = gitDiff(workspace);
  writeFileSync(join(dir, "diff.patch"), diff2);

  // 4) 重新快照 + 再复检一轮
  const ws2 = snapshotWorkspace(workspace, snapPath(id, dir, "redteam-ws-2"));
  const p2 = await o.round2(ws2, diff2);
  redteam = { ...normalizeRedteam(p2.value), repaired: p2.repaired, round: 2 };
  writeFileSync(join(dir, "redteam.json"), JSON.stringify(redteam, null, 1));

  if (jr.code !== 0 || highFindings(redteam).length) {
    writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 结论：**已升级**（redteam 修复后仍不达标）\n- judge exit：${jr.code}\n- 剩余 high：${highFindings(redteam).length}\n- 变更：见 diff.patch\n`);
    writeUsage(dir, id, usageAcc);
    setStatus(id, "escalated", "redteam: high findings remain");
    return { redteam, escalated: true };
  }
  return { redteam, escalated: false };
}

export function normalizeVerify(v: any): any {
  if (!v || typeof v !== "object") return { conclusion: "无法判定", evidence: [] };
  let conclusion = v.conclusion;
  if (!conclusion) {
    const raw = String(v.verdict ?? v.result ?? v.status ?? "").toUpperCase();
    if (v.pass === true || v.ok === true || v.success === true || ["PASS", "PASSED", "OK", "通过", "SUCCESS"].includes(raw)) conclusion = "通过";
    else if (v.pass === false || v.ok === false || ["FAIL", "FAILED", "不通过", "ERROR"].includes(raw)) conclusion = "不通过";
    else conclusion = "无法判定";
  }
  let evidence = v.evidence;
  if (!Array.isArray(evidence)) evidence = evidence ? [String(evidence)] : [];
  if (!evidence.length) {
    const parts = [];
    if (v.command) parts.push(`cmd: ${v.command}`);
    if (v.exit_code !== undefined) parts.push(`exit=${v.exit_code}`);
    if (v.detail) parts.push(String(v.detail));
    if (v.file) parts.push(`file: ${v.file}`);
    evidence = parts.length ? [parts.join(" | ")] : [];
  }
  return { ...v, conclusion, evidence, normalized: !v.conclusion };
}

export function normalizeRedteam(v: any): any {
  const findings = Array.isArray(v?.findings) ? v.findings : Array.isArray(v?.issues) ? v.issues : [];
  return { ...v, findings };
}

function gitDiff(ws: string): string {
  let out = "";
  try { out += execFileSync("git", ["-C", ws, "diff"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  try {
    const untracked = execFileSync("git", ["-C", ws, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
    for (const f of untracked) {
      const body = readFileSync(join(ws, f), "utf8");
      out += `\n--- /dev/null\n+++ b/${f}\n` + body.split("\n").map((l) => "+" + l).join("\n") + "\n";
    }
  } catch {}
  return out;
}

export async function runAcp(id: string, workspace: string) {
  const t = get(id);
  if (!t.judge) throw new Error("E_TASK: judge required");
  const dir = runDir(id); mkdirSync(dir, { recursive: true });
  const acp = new AcpClient(["opencode", "acp"], workspace, Number(process.env.DIA_ACP_TIMEOUT || DEFAULT_ACP_TIMEOUT));
  const usageAcc = { rows: [] as any[], input: 0, output: 0, total: 0, cost: 0, unpriced: 0 };
  const prices = loadPrices();
  const modelOf = (ns: any) => ns?.configOptions?.find((o: any) => o.id === "model")?.currentValue || null;
  try {
    await acp.init();

    const planNs = await acp.newSession(workspace);
    const sPlan = planNs.sessionId;
    await acp.setMode(sPlan, "dabo-planner");
    const planOut = await acp.prompt(sPlan, `Task: ${t.title}\nRepo: ${workspace}\nJudge: ${t.judge}\nKeep exploration bounded (at most 3 reads); return only the JSON object now.`);
    recordModelCall(id, "planner", modelOf(planNs), planOut.usage, usageAcc, prices);
    let plan: any;
    try {
      const planned = await parseRoleJsonWithRepair(planOut.text, async (msg) => {
        const r = await acp.prompt(sPlan, msg);
        recordModelCall(id, "planner-repair", modelOf(planNs), r.usage, usageAcc, prices);
        return r.text;
      });
      plan = planned.value;
    } catch (e: any) {
      writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 结论：**已升级**（planner 输出无法解析）\n- 错误：${e.message}\n`);
      writeUsage(dir, id, usageAcc);
      setStatus(id, "escalated", "planner: " + e.message);
      return { dir, escalated: true, error: e.message };
    }
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${JSON.stringify(plan, null, 1)}\n`);
    const judge = String(plan.judge || t.judge);

    let verify: any = null;
    let lastVerifyKey = "";
    for (let round = 0; round <= 3; round++) {
      const buildNs = await acp.newSession(workspace);
      const sBuild = buildNs.sessionId;
      await acp.setMode(sBuild, "dabo-builder");
      const fix = round === 0 ? "" : `\nPrevious verify: ${JSON.stringify(verify)}`;
      const buildOut = await acp.prompt(sBuild, `Implement this task in the repo.\nPlan: ${JSON.stringify(plan)}\nJudge: ${judge}${fix}\nReport briefly what you changed and test results.`);
      recordModelCall(id, `builder-${round}`, modelOf(buildNs), buildOut.usage, usageAcc, prices);
      writeFileSync(join(dir, `builder-${round}.md`), buildOut.text || "(no output)");

      const vws = snapshotWorkspace(workspace, snapPath(id, dir, `verify-ws-${round}`));
      const verifyNs = await acp.newSession(vws);
      const sVerify = verifyNs.sessionId;
      await acp.setMode(sVerify, "dabo-verifier");
      const vOut = await acp.prompt(sVerify, `Repo: ${vws}\nRun this judge yourself: ${judge}\nReturn only the JSON object.`);
      recordModelCall(id, `verifier-${round}`, modelOf(verifyNs), vOut.usage, usageAcc, prices);
      const fixed = await parseRoleJsonWithRepair(vOut.text, async (msg) => {
        const r = await acp.prompt(sVerify, msg);
        recordModelCall(id, `verifier-${round}-repair`, modelOf(verifyNs), r.usage, usageAcc, prices);
        return r.text;
      });
      verify = { ...normalizeVerify(fixed.value), repaired: fixed.repaired };
      writeFileSync(join(dir, "verify.json"), JSON.stringify(verify, null, 1));
      writeFileSync(join(dir, "test.log"), (verify.evidence || []).join("\n") || "(no evidence)");
      if (verify.conclusion === "通过") break;
      const key = JSON.stringify({ conclusion: verify.conclusion, evidence: verify.evidence });
      if (key === lastVerifyKey) break; // 同一失败重复，提前停
      lastVerifyKey = key;
    }

    const diff = gitDiff(workspace);
    writeFileSync(join(dir, "diff.patch"), diff);

    if (verify?.conclusion !== "通过") {
      writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 结论：**已升级**（验证未通过）\n- 验证：${verify?.conclusion}\n- 修复重试：${verify?.repaired ? "是" : "否"}\n- 证据：\n${(verify?.evidence || []).map((e: string) => "- " + e).join("\n")}\n- 变更：见 diff.patch\n`);
      writeUsage(dir, id, usageAcc);
      setStatus(id, "escalated", "verify: " + verify?.conclusion);
      return { dir, verify, escalated: true };
    }

    // 判据命令与工作区由 harness 记录，gate 会**重新执行**它（不信任任何角色写的证据）；
    // redteam high 修复后的判据复跑同样以 run.json 的 workspace 为准。
    writeFileSync(join(dir, "run.json"), JSON.stringify({ mock: false, mode: "acp", workspace, judge, ts: new Date().toISOString() }, null, 1));

    const rws = snapshotWorkspace(workspace, snapPath(id, dir, "redteam-ws"));
    const redNs = await acp.newSession(rws);
    const sRed = redNs.sessionId;
    await acp.setMode(sRed, "dabo-redteam");
    const rOut = await acp.prompt(sRed, `Repo: ${rws}\nDiff:\n${diff.slice(0, 20000)}\nReturn only the JSON object.`);
    recordModelCall(id, "redteam", modelOf(redNs), rOut.usage, usageAcc, prices);
    const fixed = await parseRoleJsonWithRepair(rOut.text, async (msg) => {
      const r = await acp.prompt(sRed, msg);
      recordModelCall(id, "redteam-repair", modelOf(redNs), r.usage, usageAcc, prices);
      return r.text;
    });
    let redteam: any = { ...normalizeRedteam(fixed.value), repaired: fixed.repaired, round: 1 };
    writeFileSync(join(dir, "redteam.json"), JSON.stringify(redteam, null, 1));

    // redteam 的 high 级反驳必须回灌 builder 修（gate 也会拦）；修完复跑判据 + 复检一轮。
    const repaired = await repairRedteamHighs({
      id, dir, task: t, workspace, judge, redteam, usageAcc,
      builderFix: async (findings) => {
        const fixNs = await acp.newSession(workspace);
        await acp.setMode(fixNs.sessionId, "dabo-builder");
        const fOut = await acp.prompt(fixNs.sessionId, `Fix these high-severity findings. Keep the judge green; do not change the judge itself.\n${JSON.stringify(findings)}\nReturn a brief summary.`);
        recordModelCall(id, "builder-fix", modelOf(fixNs), fOut.usage, usageAcc, prices);
      },
      round2: async (rws2, diff2) => {
        const red2 = await acp.newSession(rws2);
        await acp.setMode(red2.sessionId, "dabo-redteam");
        const rOut2 = await acp.prompt(red2.sessionId, `Round: 2\nRepo: ${rws2}\nDiff:\n${diff2.slice(0, 20000)}\nReturn only the JSON object.`);
        recordModelCall(id, "redteam-2", modelOf(red2), rOut2.usage, usageAcc, prices);
        return await parseRoleJsonWithRepair(rOut2.text, async (msg) => {
          const r = await acp.prompt(red2.sessionId, msg);
          recordModelCall(id, "redteam-2-repair", modelOf(red2), r.usage, usageAcc, prices);
          return r.text;
        });
      },
    });
    redteam = repaired.redteam;
    if (repaired.escalated) return { dir, verify, redteam, escalated: true };

    writeUsage(dir, id, usageAcc);
    writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 判据：${judge}\n- 验证：${verify?.conclusion}\n- 修复重试：${verify?.repaired ? "是" : "否"} / redteam：${redteam.repaired ? "是" : "否"}\n- 反驳：${(redteam.findings || []).length} 条\n- 模型调用：${usageAcc.rows.length} 次 / ${usageAcc.total} tokens\n`);
    setStatus(id, "awaiting_acceptance", "acp run");
    return { dir, verify, redteam };
  } finally {
    acp.close();
    cleanupSnapshots(dir);
  }
}

function dshSessionFile(sessionId: string): string | null {
  const root = join(homedir(), ".dsh", "sessions");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, sessionId, "session.v4.jsonl.zstd");
    if (existsSync(f)) return f;
  }
  return null;
}

function dshUsages(file: string): { usage: any; model: string | null }[] {
  const raw = zstdDecompressSync(readFileSync(file)).toString("utf8");
  const out: { usage: any; model: string | null }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant/message") continue;
    const u = d.data?.usage;
    if (!u) continue;
    const src = d.data?.message?.source;
    out.push({ usage: u, model: src?.provider && src?.model ? `${src.provider}/${src.model}` : null });
  }
  return out;
}

async function callDsh(role: string, cwd: string, text: string, tracker: Map<string, number>) {
  const acp = new AcpClient(["dsh", "--profile", `dabo-${role}`], cwd, Number(process.env.DIA_ACP_TIMEOUT || DEFAULT_ACP_TIMEOUT));
  try {
    await acp.init();
    const ns = await acp.newSession(cwd);
    // 模型由 dsh profile / 用户配置决定；需要显式覆盖时用 DIA_DSH_MODEL=provider/model
    const override = process.env.DIA_DSH_MODEL?.trim();
    if (override) {
      const value = override.startsWith("[") ? override : JSON.stringify(override.split("/"));
      await acp.setConfig(ns.sessionId, "model", value);
    }
    const before = tracker.get(ns.sessionId) || 0;
    const r = await acp.prompt(ns.sessionId, text);
    const file = dshSessionFile(ns.sessionId);
    let usage: any = r.usage;
    let model: string | null = override && !override.startsWith("[") ? override : null;
    let all: { usage: any; model: string | null }[] = [];
    for (let i = 0; i < 6; i++) {
      const f = file || dshSessionFile(ns.sessionId);
      if (f) {
        all = dshUsages(f);
        if (all.length > before) break;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    if (all.length) {
      const fresh = all.slice(before);
      tracker.set(ns.sessionId, all.length);
      if (fresh.length) {
        usage = fresh.reduce((a, x) => ({
          inputTokens: (a.inputTokens || 0) + (x.usage.inputTokens || 0),
          outputTokens: (a.outputTokens || 0) + (x.usage.outputTokens || 0),
          totalTokens: (a.totalTokens || 0) + (x.usage.totalTokens || 0),
          cacheReadTokens: (a.cacheReadTokens || 0) + (x.usage.cacheReadTokens || 0),
        }), {} as any);
        model = fresh[fresh.length - 1].model || model;
      }
    }
    return { text: r.text, usage, model };
  } finally {
    acp.close();
  }
}

export async function runDsh(id: string, workspace: string) {
  const t = get(id);
  if (!t.judge) throw new Error("E_TASK: judge required");
  const dir = runDir(id); mkdirSync(dir, { recursive: true });
  const usageAcc = { rows: [] as any[], input: 0, output: 0, total: 0, cost: 0, unpriced: 0 };
  const prices = loadPrices();
  const tracker = new Map<string, number>();
  try {
    const planOut = await callDsh("planner", workspace, `Task: ${t.title}\nRepo: ${workspace}\nJudge: ${t.judge}\nReturn only the JSON object.`, tracker);
    recordModelCall(id, "planner", planOut.model, planOut.usage, usageAcc, prices);
    let plan: any;
    try {
      const planned = await parseRoleJsonWithRepair(planOut.text, async (msg) => {
        const ctx = `Task: ${t.title}\nRepo: ${workspace}\nJudge: ${t.judge}\n`;
        const r = await callDsh("planner", workspace, ctx + msg, tracker);
        recordModelCall(id, "planner-repair", r.model, r.usage, usageAcc, prices);
        return r.text;
      });
      plan = planned.value;
    } catch (e: any) {
      writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 结论：**已升级**（planner 输出无法解析）\n- 错误：${e.message}\n`);
      writeUsage(dir, id, usageAcc);
      setStatus(id, "escalated", "planner: " + e.message);
      return { dir, escalated: true, error: e.message };
    }
    writeFileSync(join(dir, "plan.md"), `# Plan\n\n${JSON.stringify(plan, null, 1)}\n`);
    const judge = String(plan.judge || t.judge);

    let verify: any = null;
    let lastKey = "";
    for (let round = 0; round <= 3; round++) {
      const fix = round === 0 ? "" : `\nPrevious verify: ${JSON.stringify(verify)}`;
      const buildOut = await callDsh("builder", workspace, `Implement this task in the repo.\nPlan: ${JSON.stringify(plan)}\nJudge: ${judge}${fix}\nReport briefly what you changed and test results.`, tracker);
      recordModelCall(id, `builder-${round}`, buildOut.model, buildOut.usage, usageAcc, prices);
      writeFileSync(join(dir, `builder-${round}.md`), buildOut.text || "(no output)");

      const vws = snapshotWorkspace(workspace, snapPath(id, dir, `verify-ws-${round}`));
      const vOut = await callDsh("verifier", vws, `Repo: ${vws}\nRun this judge yourself: ${judge}\nReturn only the JSON object.`, tracker);
      recordModelCall(id, `verifier-${round}`, vOut.model, vOut.usage, usageAcc, prices);
      const fixed = await parseRoleJsonWithRepair(vOut.text, async (msg) => {
        const r = await callDsh("verifier", vws, `Repo: ${vws}\nJudge: ${judge}\n${msg}`, tracker);
        recordModelCall(id, `verifier-${round}-repair`, r.model, r.usage, usageAcc, prices);
        return r.text;
      });
      verify = { ...normalizeVerify(fixed.value), repaired: fixed.repaired };
      writeFileSync(join(dir, "verify.json"), JSON.stringify(verify, null, 1));
      writeFileSync(join(dir, "test.log"), (verify.evidence || []).join("\n") || "(no evidence)");
      if (verify.conclusion === "通过") break;
      const key = JSON.stringify({ conclusion: verify.conclusion, evidence: verify.evidence });
      if (key === lastKey) break;
      lastKey = key;
    }

    const diff = gitDiff(workspace);
    writeFileSync(join(dir, "diff.patch"), diff);

    if (verify?.conclusion !== "通过") {
      writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 结论：**已升级**（验证未通过）\n- 验证：${verify?.conclusion}\n- 修复重试：${verify?.repaired ? "是" : "否"}\n- 证据：\n${(verify?.evidence || []).map((e: string) => "- " + e).join("\n")}\n- 变更：见 diff.patch\n`);
      writeUsage(dir, id, usageAcc);
      setStatus(id, "escalated", "verify: " + verify?.conclusion);
      return { dir, verify, escalated: true };
    }

    // 判据命令与工作区由 harness 记录，gate 会**重新执行**它；redteam 修复后的判据复跑也以 run.json 为准。
    writeFileSync(join(dir, "run.json"), JSON.stringify({ mock: false, mode: "dsh", workspace, judge, ts: new Date().toISOString() }, null, 1));

    const rws = snapshotWorkspace(workspace, snapPath(id, dir, "redteam-ws"));
    const rOut = await callDsh("redteam", rws, `Repo: ${rws}\nDiff:\n${diff.slice(0, 20000)}\nReturn only the JSON object.`, tracker);
    recordModelCall(id, "redteam", rOut.model, rOut.usage, usageAcc, prices);
    const fixed = await parseRoleJsonWithRepair(rOut.text, async (msg) => {
      const r = await callDsh("redteam", rws, `Repo: ${rws}\nDiff:\n${diff.slice(0, 20000)}\n${msg}`, tracker);
      recordModelCall(id, "redteam-repair", r.model, r.usage, usageAcc, prices);
      return r.text;
    });
    let redteam: any = { ...normalizeRedteam(fixed.value), repaired: fixed.repaired, round: 1 };
    writeFileSync(join(dir, "redteam.json"), JSON.stringify(redteam, null, 1));

    // 与 ACP 路径同一套闭环：high 回灌 builder 修 → 复跑判据 → 再复检一轮；仍不达标就升级。
    const repaired = await repairRedteamHighs({
      id, dir, task: t, workspace, judge, redteam, usageAcc,
      builderFix: async (findings) => {
        const fOut = await callDsh("builder", workspace, `Fix these high-severity findings. Keep the judge green; do not change the judge itself.\n${JSON.stringify(findings)}\nReturn a brief summary.`, tracker);
        recordModelCall(id, "builder-fix", fOut.model, fOut.usage, usageAcc, prices);
      },
      round2: async (rws2, diff2) => {
        const rOut2 = await callDsh("redteam", rws2, `Round: 2\nRepo: ${rws2}\nDiff:\n${diff2.slice(0, 20000)}\nReturn only the JSON object.`, tracker);
        recordModelCall(id, "redteam-2", rOut2.model, rOut2.usage, usageAcc, prices);
        return await parseRoleJsonWithRepair(rOut2.text, async (msg) => {
          const r = await callDsh("redteam", rws2, `Round: 2\nRepo: ${rws2}\nDiff:\n${diff2.slice(0, 20000)}\n${msg}`, tracker);
          recordModelCall(id, "redteam-2-repair", r.model, r.usage, usageAcc, prices);
          return r.text;
        });
      },
    });
    redteam = repaired.redteam;
    if (repaired.escalated) return { dir, verify, redteam, escalated: true };

    writeUsage(dir, id, usageAcc);
    writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 判据：${judge}\n- 验证：${verify?.conclusion}\n- 修复重试：${verify?.repaired ? "是" : "否"} / redteam：${redteam.repaired ? "是" : "否"}\n- 反驳：${(redteam.findings || []).length} 条\n- 模型调用：${usageAcc.rows.length} 次 / ${usageAcc.total} tokens\n`);
    writeFileSync(join(dir, "run.json"), JSON.stringify({ mock: false, mode: "dsh", workspace, judge, ts: new Date().toISOString() }, null, 1));
    setStatus(id, "awaiting_acceptance", "dsh run");
    return { dir, verify, redteam };
  } finally {
    cleanupSnapshots(dir);
  }
}

export function accept(id: string, note = "") {
  const g = gate(id); if (!g.ok) throw new Error("E_GATE: " + g.reason);
  setStatus(id, "accepted", note || "human accepted"); return get(id);
}

export function reject(id: string, reason: string) {
  if (!reason) throw new Error("E_TASK: reason required");
  setStatus(id, "rejected", reason); return get(id);
}// ACP 单次 prompt 默认超时：plan/builder 长任务实测 180s 不够（2026-11-03 builder 被掐断），抬到 10 分钟。
export const DEFAULT_ACP_TIMEOUT = 600_000;


