import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  setStatus(id, "awaiting_acceptance", "mock run");
  return dir;
}

export function gate(id: string) {
  const dir = runDir(id);
  const need = ["plan.md", "diff.patch", "test.log", "verify.json", "redteam.json", "packet.md"];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) return { ok: false, reason: "missing: " + missing.join(",") };
  let verify: any, redteam: any;
  try { verify = JSON.parse(readFileSync(join(dir, "verify.json"), "utf8")); } catch { return { ok: false, reason: "bad verify.json" }; }
  try { redteam = JSON.parse(readFileSync(join(dir, "redteam.json"), "utf8")); } catch { return { ok: false, reason: "bad redteam.json" }; }
  if (!["通过", "不通过", "无法判定"].includes(verify.conclusion)) return { ok: false, reason: "bad conclusion" };
  if (verify.conclusion !== "通过") return { ok: false, reason: "verify conclusion: " + verify.conclusion };
  if (!Array.isArray(verify.evidence) || !verify.evidence.length) return { ok: false, reason: "no evidence" };
  if (verify.evidence.some((e: any) => {
    const t = String(e).trim();
    return !t || t === "(no evidence)" || t === "invalid verifier output";
  })) return { ok: false, reason: "placeholder evidence" };
  if (!Array.isArray(redteam.findings)) return { ok: false, reason: "bad findings" };
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
  for (const e of readdirSync(runDir)) {
    if (e.startsWith("verify-ws-") || e === "redteam-ws") rmSync(join(runDir, e), { recursive: true, force: true });
  }
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
  const acp = new AcpClient(["opencode", "acp"], workspace, Number(process.env.DIA_ACP_TIMEOUT || 180000));
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
      writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: usageAcc.rows.length, input_tokens: usageAcc.input, output_tokens: usageAcc.output, total_tokens: usageAcc.total, cost_usd: usageAcc.cost, unpriced_calls: usageAcc.unpriced, by_role: usageAcc.rows }, null, 1));
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

      const vws = snapshotWorkspace(workspace, join(dir, `verify-ws-${round}`));
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
      writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: usageAcc.rows.length, input_tokens: usageAcc.input, output_tokens: usageAcc.output, total_tokens: usageAcc.total, cost_usd: usageAcc.cost, unpriced_calls: usageAcc.unpriced, by_role: usageAcc.rows }, null, 1));
      setStatus(id, "escalated", "verify: " + verify?.conclusion);
      return { dir, verify, escalated: true };
    }

    const rws = snapshotWorkspace(workspace, join(dir, "redteam-ws"));
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
    const redteam = { ...normalizeRedteam(fixed.value), repaired: fixed.repaired };
    writeFileSync(join(dir, "redteam.json"), JSON.stringify(redteam, null, 1));

    writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: usageAcc.rows.length, input_tokens: usageAcc.input, output_tokens: usageAcc.output, total_tokens: usageAcc.total, cost_usd: usageAcc.cost, unpriced_calls: usageAcc.unpriced, by_role: usageAcc.rows }, null, 1));
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
  const acp = new AcpClient(["dsh", "--profile", `dabo-${role}`], cwd, Number(process.env.DIA_ACP_TIMEOUT || 180000));
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
      writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: usageAcc.rows.length, input_tokens: usageAcc.input, output_tokens: usageAcc.output, total_tokens: usageAcc.total, cost_usd: usageAcc.cost, unpriced_calls: usageAcc.unpriced, by_role: usageAcc.rows }, null, 1));
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

      const vws = snapshotWorkspace(workspace, join(dir, `verify-ws-${round}`));
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
      writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: usageAcc.rows.length, input_tokens: usageAcc.input, output_tokens: usageAcc.output, total_tokens: usageAcc.total, cost_usd: usageAcc.cost, unpriced_calls: usageAcc.unpriced, by_role: usageAcc.rows }, null, 1));
      setStatus(id, "escalated", "verify: " + verify?.conclusion);
      return { dir, verify, escalated: true };
    }

    const rws = snapshotWorkspace(workspace, join(dir, "redteam-ws"));
    const rOut = await callDsh("redteam", rws, `Repo: ${rws}\nDiff:\n${diff.slice(0, 20000)}\nReturn only the JSON object.`, tracker);
    recordModelCall(id, "redteam", rOut.model, rOut.usage, usageAcc, prices);
    const fixed = await parseRoleJsonWithRepair(rOut.text, async (msg) => {
      const r = await callDsh("redteam", rws, `Repo: ${rws}\nDiff:\n${diff.slice(0, 20000)}\n${msg}`, tracker);
      recordModelCall(id, "redteam-repair", r.model, r.usage, usageAcc, prices);
      return r.text;
    });
    const redteam = { ...normalizeRedteam(fixed.value), repaired: fixed.repaired };
    writeFileSync(join(dir, "redteam.json"), JSON.stringify(redteam, null, 1));
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ task_id: id, calls: usageAcc.rows.length, input_tokens: usageAcc.input, output_tokens: usageAcc.output, total_tokens: usageAcc.total, cost_usd: usageAcc.cost, unpriced_calls: usageAcc.unpriced, by_role: usageAcc.rows }, null, 1));
    writeFileSync(join(dir, "packet.md"), `# 验收包 ${id}\n\n- 任务：${t.title}\n- 判据：${judge}\n- 验证：${verify?.conclusion}\n- 修复重试：${verify?.repaired ? "是" : "否"} / redteam：${redteam.repaired ? "是" : "否"}\n- 反驳：${(redteam.findings || []).length} 条\n- 模型调用：${usageAcc.rows.length} 次 / ${usageAcc.total} tokens\n`);
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
}
