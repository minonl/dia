// doctor.ts — 组合自检：把各能力的「是否健康」收成一个入口
//
// 只做组合与判定，不实现检查逻辑：
//   persona verify / kit verify / default_agent / kb 索引 / wt 包 / job 包
// 退出码：0 全绿；1 有 warn；2 有 fail（便于脚本与 CI 判定）
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as persona from "./persona.ts";
import * as kit from "./kit.ts";
import * as scope from "./scope.ts";
import * as active from "./active.ts";
import * as dsh from "./dsh.ts";
import * as platforms from "./platforms.ts";
import * as deps from "./deps.ts";
import { indexStatus, type IndexStatus } from "./kb.ts";

export interface Check { name: string; status: "ok" | "warn" | "fail"; detail: string }

const home = () => process.env.DIA_HOME || homedir();

// 平台自检只报告「装没装、版本在不在支持范围」，不判红：渲染不需要宿主，运行才需要。
// 数据来自单一事实源 docs/platforms/registry.json（安装版在 <install>/registry/platforms.json）。
function depsChecks(): Check[] {
  const entries = deps.load();
  if (!entries.length) return [{ name: "deps", status: "warn", detail: "依赖登记未安装（docs/deps.jsonl）" }];
  const s = deps.summary(entries);
  return [{ name: "deps", status: s.status, detail: s.detail }];
}

function platformChecks(): Check[] {
  const reg = platforms.load();
  if (!reg) return [{ name: "platforms", status: "warn", detail: "平台注册表未安装（docs/platforms/registry.json）" }];
  return platforms.checks(reg).map((c) => ({ ...c, status: c.status as Check["status"] }));
}

/** detail 里的重建命令要能直接复制执行：含 shell 元字符时加单引号（导出仅为单测覆盖转义）。 */
export function quoteArg(v: string): string {
  return /^[\w.@%+=:,\/-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

function describeStale(st: IndexStatus): string {
  const diff = st.added + st.removed + st.changed;
  const parts = [st.added ? `新增 ${st.added}` : "", st.removed ? `删除 ${st.removed}` : "", st.changed ? `修改 ${st.changed}` : ""].filter(Boolean);
  const behind = diff ? `落后 ${diff} 篇（${parts.join(" / ")}）` : st.contentOnly ? "内容已变更（同一秒内改动，mtime 未变）" : "已落后";
  return `索引${behind}：索引 ${st.indexed} 篇 → 磁盘 ${st.scanned} 篇`;
}

/**
 * 知识索引新鲜度（三态）：
 *   目录缺失 → fail（persona 声明了知识根却没有，是真问题）
 *   索引缺失 / 落后 / 属于别的知识根 → warn（运行时 `dia kb query` 会自动重建，不该判红）
 *   索引一致 → ok
 * 判定复用 packages/kb 的 `indexStatus`（与 `assertIndex` 同口径），doctor 不自己再扫一遍。
 */
async function knowledgeCheck(id: string, prefix: string, root: string): Promise<Check> {
  const name = `${prefix}knowledge`;
  if (!existsSync(root)) return { name, status: "fail", detail: root };
  const rebuild = `dia kb index --persona ${quoteArg(id)}`;
  let st: IndexStatus;
  try { st = await indexStatus(root); }
  catch (e: any) { return { name, status: "warn", detail: `${root}（索引不可读：${e?.message || String(e)}；重建：${rebuild}）` }; }
  if (st.state === "ok") return { name, status: "ok", detail: `${root}（索引 ${st.indexed} 篇，已是最新）` };
  const why = st.state === "missing" ? "索引不存在"
    : st.state === "foreign" ? `索引属于其它知识根（${st.db}）`
    : describeStale(st);
  return { name, status: "warn", detail: `${root}（${why}；重建：${rebuild}）` };
}

/**
 * 单个 persona 的作用域检查。`prefix` 用于多 persona 场景区分条目（如 `dabo.persona`）。
 * 显式指定了不存在的 persona ⇒ 只报 scope fail，不再顺手报「未安装任何 persona」（旧行为会自相矛盾）。
 */
async function personaChecks(id: string, prefix: string, shared: Map<string, { check: Check; id: string }>): Promise<Check[]> {
  const checks: Check[] = [];
  let sc: scope.Scope | null = null;
  try { sc = scope.current(id); }
  catch (e: any) { checks.push({ name: "scope", status: "fail", detail: e?.message || String(e) }); }
  if (!sc) return checks;

  const eff = active.effective(sc.id);
  checks.push({
    name: `${prefix}persona`,
    status: "ok",
    detail: `${sc.id}@${sc.version}（生效来源：${eff?.source === "active" ? "active 指针" : "最新安装"}）`,
  });
  try {
    const v = persona.verify(sc.id, sc.version);
    checks.push({ name: `${prefix}persona.verify`, status: v.ok ? "ok" : "fail", detail: v.ok ? "内容哈希一致" : (v.issues[0] ?? "drift") });
  } catch (e: any) { checks.push({ name: `${prefix}persona.verify`, status: "fail", detail: e?.message }); }

  // kit 校验
  const installed = kit.list();
  if (!installed.length) checks.push({ name: `${prefix}kits`, status: "ok", detail: "无独立 kit（内容由 persona 自带）" });
  for (const k of installed) {
    for (const v of k.versions) {
      try {
        const r = kit.verify(k.id, v);
        checks.push({ name: `${prefix}kit:${k.id}@${v}`, status: r.ok ? "ok" : "fail", detail: r.ok ? "一致" : r.drift.join("; ") });
      } catch (e: any) {
        checks.push({ name: `${prefix}kit:${k.id}@${v}`, status: "fail", detail: e?.message });
      }
    }
  }

  // 知识根可读 + 索引是否落后
  if (sc.knowledgeRoot) {
    const key = resolve(sc.knowledgeRoot);
    const hit = shared.get(key);
    if (hit) {
      // 多 persona 共享同一知识根（典型：同一个 kit）：只算一次，避免同一问题刷屏
      checks.push({ ...hit.check, name: `${prefix}knowledge`, detail: `${hit.check.detail}（与 ${hit.id} 共享知识根）` });
    } else {
      const c = await knowledgeCheck(id, prefix, sc.knowledgeRoot);
      shared.set(key, { check: c, id });
      checks.push(c);
    }
  }

  // 宿主 dsh 的 preset 自检（dsh 不装 / 没渲染 profile 时跳过）
  const profiles = process.env.DIA_DSH_PROFILES_DIR || join(home(), ".dsh", "profiles");
  const preset = dsh.checkPreset(sc.id, join(profiles, sc.id));
  checks.push({
    name: `${prefix}dsh.preset`,
    status: preset.issues.length ? "fail" : "ok",
    detail: preset.issues[0] ?? preset.skipped ?? "preset 插件配置可加载",
  });
  return checks;
}

export async function run(opts: { persona?: string } = {}): Promise<{
  persona: string | null;
  personas: string[];
  checks: Check[];
  verdict: "ok" | "warn" | "fail";
}> {
  const checks: Check[] = [];
  const explicit = opts.persona || process.env.DIA_PERSONA;

  // 不指定 persona：装了多个就**逐个自检**（旧行为是整体 fail，等于多 persona 机器上 doctor 不可用）。
  let ids: string[] = [];
  if (explicit) ids = [explicit];
  else {
    try {
      const s = scope.current();
      if (s) ids = [s.id];
    } catch { ids = scope.installedPersonas(); }
  }

  if (!ids.length) {
    checks.push({ name: "persona", status: "warn", detail: "未安装任何 persona（dia persona add …）" });
  }

  const multi = ids.length > 1;
  const shared = new Map<string, { check: Check; id: string }>();
  let primary: scope.Scope | null = null;
  for (const id of ids) {
    checks.push(...(await personaChecks(id, multi ? `${id}.` : "", shared)));
    if (!primary) { try { primary = scope.current(id); } catch { /* scope 检查里已报 */ } }
  }

  // 默认 agent 只是**信息项**：dia 的契约就是「只新增、不改默认」，
  // 因此默认指向别处（或未设置）都不算不健康——不要越界替用户判红。
  try {
    const d = persona.showDefaultAgent({ host: "opencode" });
    checks.push({
      name: "default_agent",
      status: "ok",
      detail: d.current
        ? `当前 ${d.current}${primary && d.current !== primary.id ? "（dia 不自动切换）" : ""}`
        : "未设置（dia 不自动设置）",
    });
  } catch (e: any) { checks.push({ name: "default_agent", status: "warn", detail: e?.message }); }

  checks.push(...depsChecks());
  checks.push(...platformChecks());

  const wt = join(process.env.DIA_HOME_INSTALL || join(home(), ".local", "share", "dia"), "packages/wt/bin/dia-wt");
  checks.push({ name: "wt", status: existsSync(wt) ? "ok" : "warn", detail: existsSync(wt) ? wt : "dia wt 未安装（dia install.sh）" });

  const verdict = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { persona: ids.length === 1 ? ids[0] : null, personas: ids, checks, verdict };
}
