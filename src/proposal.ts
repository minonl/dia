import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { list as listTasks } from "./task.ts";
import * as deps from "./deps.ts";
import * as paths from "./paths.ts";

const DATA = () => paths.diaHome();

export interface Proposal {
  id: string;
  title: string;
  why: string;
  evidence: string[];
  source: "task" | "verify" | "redteam" | "deps" | "hypothesis";
  severity: "high" | "medium" | "low";
  cost: "low" | "medium" | "high";
  score: number;
}

const SEV = { high: 3, medium: 2, low: 1 };
const COST = { low: 0, medium: 1, high: 2 };

function pid(s: string): string {
  return "p-" + createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function push(out: Proposal[], p: Omit<Proposal, "id" | "score">) {
  const score = SEV[p.severity] * 2 + Math.min(p.evidence.length, 3) - COST[p.cost];
  out.push({ ...p, id: pid(p.title), score });
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function collectRuns(out: Proposal[]) {
  const root = join(DATA(), "runs");
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const verify = readJson(join(dir, "verify.json"));
    if (verify && verify.conclusion && verify.conclusion !== "通过") {
      push(out, {
        title: `修复验证失败：${id}`,
        why: `最近一次验证结论为「${verify.conclusion}」，需要定位是判据、实现还是环境问题。`,
        evidence: [`verify.json conclusion=${verify.conclusion}`, ...(verify.evidence || []).slice(0, 2)],
        source: "verify", severity: "high", cost: "medium",
      });
    }
    const red = readJson(join(dir, "redteam.json"));
    const high = Array.isArray(red?.findings) ? red.findings.filter((f: any) => f.severity === "high") : [];
    if (high.length) {
      push(out, {
        title: `处理对抗高危：${id}`,
        why: `redteam 报告了 ${high.length} 条高危发现，未处置前不应视为完成。`,
        evidence: high.slice(0, 2).map((f: any) => `${f.trigger || "?"} → ${f.consequence || "?"}`),
        source: "redteam", severity: "high", cost: "medium",
      });
    }
  }
}

function collectTasks(out: Proposal[]) {
  for (const t of listTasks()) {
    if (t.status === "escalated" && !out.some((p) => p.title.includes(t.id))) {
      push(out, {
        title: `处理升级任务：${t.id}`,
        why: `任务「${t.title}」已升级，等待归因或拆解。`,
        evidence: [`status=escalated`, t.evidence || "(no reason)"],
        source: "task", severity: "high", cost: "medium",
      });
    }
  }
}

function collectDeps(out: Proposal[], path: string) {
  if (!existsSync(path)) return;
  for (const e of deps.load(path)) {
    if (e.result === "unknown" || e.support === "unknown") {
      push(out, {
        title: `复核依赖：${e.id}`,
        why: "依赖状态为 unknown，不能作为已知可用项。",
        evidence: [`deps.jsonl: ${e.id}`, `result=${e.result ?? "?"} support=${e.support ?? "?"}`],
        source: "deps", severity: "medium", cost: "low",
      });
    }
  }
}

function expandIds(cell: string): string[] {
  const out: string[] = [];
  for (const part of cell.split("/")) {
    const p = part.trim().replace(/\*/g, "");
    const range = p.match(/^H(\d+)\s*[–-]\s*H(\d+)$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push("H" + i);
      continue;
    }
    const m = p.match(/^H\d+$/);
    if (m) out.push(p);
  }
  return out;
}

function collectHypotheses(out: Proposal[], path: string) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const titles = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/\|\s*\*\*(H\d+)\*\*\s*\|\s*([^|]+)/);
    if (m) titles.set(m[1], m[2].trim());
  }
  for (const line of lines) {
    if (!line.startsWith("|") || !line.includes("待验证")) continue;
    const cols = line.split("|").map((c) => c.trim());
    for (const id of expandIds(cols[1] || "")) {
      push(out, {
        title: `验证假设：${id}${titles.get(id) ? " " + titles.get(id) : ""}`,
        why: "假设仍为待验证；先跑低成本实验，避免把假设当结论。",
        evidence: [`hypotheses: ${id}`, "status=待验证"],
        source: "hypothesis", severity: "medium", cost: "low",
      });
    }
  }
}

export function propose(opts: { depsPath?: string; hypothesesPath?: string; limit?: number } = {}): Proposal[] {
  const out: Proposal[] = [];
  collectRuns(out);
  collectTasks(out);
  collectDeps(out, opts.depsPath || join(process.cwd(), "docs", "deps.jsonl"));
  collectHypotheses(out, opts.hypothesesPath || join(process.cwd(), "docs", "hypotheses.md"));
  const seen = new Set<string>();
  return out
    .filter((p) => (seen.has(p.title) ? false : (seen.add(p.title), true)))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}
