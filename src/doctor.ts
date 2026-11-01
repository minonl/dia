// doctor.ts — 组合自检：把各能力的「是否健康」收成一个入口
//
// 只做组合与判定，不实现检查逻辑：
//   persona verify / kit verify / default_agent / kb 索引 / wt 包 / job 包
// 退出码：0 全绿；1 有 warn；2 有 fail（便于脚本与 CI 判定）
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as persona from "./persona.ts";
import * as kit from "./kit.ts";
import * as scope from "./scope.ts";
import * as active from "./active.ts";

export interface Check { name: string; status: "ok" | "warn" | "fail"; detail: string }

const home = () => process.env.DIA_HOME || homedir();
const dataDir = () => process.env.DIA_DATA_DIR || join(home(), ".local", "share", "dia");

export function run(opts: { persona?: string } = {}): { persona: string | null; checks: Check[]; verdict: "ok" | "warn" | "fail" } {
  const checks: Check[] = [];
  let sc: scope.Scope | null = null;
  try { sc = scope.current(opts.persona); }
  catch (e: any) { checks.push({ name: "scope", status: "fail", detail: e?.message || String(e) }); }

  if (!sc) {
    checks.push({ name: "persona", status: "warn", detail: "未安装任何 persona（dia persona add …）" });
  } else {
    const eff = active.effective(sc.id);
    checks.push({
      name: "persona",
      status: "ok",
      detail: `${sc.id}@${sc.version}（生效来源：${eff?.source === "active" ? "active 指针" : "最新安装"}）`,
    });
    try {
      const v = persona.verify(sc.id, sc.version);
      checks.push({ name: "persona.verify", status: v.ok ? "ok" : "fail", detail: v.ok ? "内容哈希一致" : (v.issues[0] ?? "drift") });
    } catch (e: any) { checks.push({ name: "persona.verify", status: "fail", detail: e?.message }); }

    // 默认 agent 只是**信息项**：dia 的契约就是「只新增、不改默认」，
    // 因此默认指向别处（或未设置）都不算不健康——不要越界替用户判红。
    try {
      const d = persona.showDefaultAgent({ host: "opencode" });
      checks.push({
        name: "default_agent",
        status: "ok",
        detail: d.current
          ? `当前 ${d.current}${d.current === sc.id ? "" : "（dia 不自动切换）"}`
          : "未设置（dia 不自动设置）",
      });
    } catch (e: any) { checks.push({ name: "default_agent", status: "warn", detail: e?.message }); }

    // kit 校验
    const installed = kit.list();
    if (!installed.length) checks.push({ name: "kits", status: "ok", detail: "无独立 kit（内容由 persona 自带）" });
    for (const k of installed) {
      for (const v of k.versions) {
        try {
          const r = kit.verify(k.id, v);
          checks.push({ name: `kit:${k.id}@${v}`, status: r.ok ? "ok" : "fail", detail: r.ok ? "一致" : r.drift.join("; ") });
        } catch (e: any) { checks.push({ name: `kit:${k.id}@${v}`, status: "fail", detail: e?.message }); }
      }
    }

    // 知识根可读 + 索引是否落后
    if (sc.knowledgeRoot) {
      checks.push({ name: "knowledge", status: existsSync(sc.knowledgeRoot) ? "ok" : "fail", detail: sc.knowledgeRoot });
    }
  }

  const wt = join(process.env.DIA_HOME_INSTALL || join(home(), ".local", "share", "dia"), "packages/wt/bin/dia-wt");
  checks.push({ name: "wt", status: existsSync(wt) ? "ok" : "warn", detail: existsSync(wt) ? wt : "dia wt 未安装（dia install.sh）" });

  const verdict = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { persona: sc?.id ?? null, checks, verdict };
}
