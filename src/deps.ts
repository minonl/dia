// deps.ts — 外部依赖登记（docs/deps.jsonl）的读取与实测校验（M1）
//
// 单一事实源：docs/deps.jsonl（只追加；同一 id 以最后一行为准）。
// 人读视图由 dia doctor 派生，不要在 md 里再抄一份。
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "./paths.ts";
import * as platforms from "./platforms.ts";

export interface DepEntry {
  id: string;
  kind: string;
  version: string;
  resolved?: string;
  integrity?: string;
  role?: "required" | "optional" | string;
  verified_at?: string;
  verified_by?: string;
  method?: string;
  result?: "pass" | "fail" | "unknown" | string;
  support?: string;
  removal_after?: string;
  evidence?: string;
}

export interface DepCheck { id: string; status: "ok" | "warn" | "fail"; detail: string; note?: boolean }

const home = () => process.env.DIA_HOME || homedir();

export function candidates(): string[] {
  const out: string[] = [];
  if (process.env.DIA_DEPS_FILE) out.push(process.env.DIA_DEPS_FILE);
  const install = paths.installDir();
  out.push(join(install, "registry", "deps.jsonl"));
  out.push(join(install, "docs", "deps.jsonl"));  // npm 包内没有 registry/，回退 docs
  out.push(join(process.cwd(), "docs", "deps.jsonl"));
  return out;
}

export function file(): string | null {
  return candidates().find((p) => existsSync(p)) ?? null;
}

/**
 * 读 JSONL；坏行跳过。
 * 去重键 = **去掉末尾 @版本**（`host_cli:opencode@2.1.3` 与 `@2.2.5` 是同一条依赖的两个版本行）：
 * 只追加语义下"升级 = 新行"，机器视图必须收敛到最新一行，否则旧行会被当成永久漂移。
 */
export function load(p?: string): DepEntry[] {
  const path = p ?? file();
  if (!path) return [];
  const keyOf = (e: DepEntry) => e.id.replace(/@[^@]*$/, "");
  const latest = new Map<string, DepEntry>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const e = JSON.parse(text) as DepEntry;
      if (e?.id && e?.kind) latest.set(keyOf(e), e);
    } catch { /* 坏行跳过，不阻断 */ }
  }
  return [...latest.values()];
}

const expand = (p: string) => (p === "~" ? home() : p.startsWith("~/") ? join(home(), p.slice(2)) : p);

function binOf(id: string): string | null {
  const m = id.match(/^[a-z_]+:([^@]+)@/);
  return m ? m[1] : null;
}

function versionOf(text: string): string | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** 登记版本支持通配：`2.2.5`（精确）、`2.2.x`/`2.2.*`/`2.2`（主.次匹配，容忍补丁漂移）。 */
export interface VerSpec { major: number; minor?: number; patch?: number }
export function parseSpec(v: string): VerSpec | null {
  const m = String(v || "").trim().match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (!m) return null;
  const num = (s?: string) => (s && s !== "x" && s !== "*" ? Number(s) : undefined);
  return { major: Number(m[1]), minor: num(m[2]), patch: num(m[3]) };
}
export function matchesSpec(actual: string, spec: VerSpec): boolean {
  const [a, b, c] = actual.split(".").map(Number);
  if (a !== spec.major) return false;
  if (spec.minor !== undefined && b !== spec.minor) return false;
  if (spec.patch !== undefined && c !== spec.patch) return false;
  return true;
}

function probeVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n")[0] || null;
  } catch { return null; }
}

/**
 * host_cli 的平台声明（docs/platforms/registry.json 按命令名索引）。
 * 为什么判定权要归这里（2026-11-16）：deps.jsonl 的 `version` 是**登记当时的快照**
 * （如 `host_cli:dsh@0.2.1-rc.2`），宿主一升级就永远报「漂移」；而 platforms 注册表本来
 * 就维护 `range`（如 `>=0.2.0 <0.3.0`）——两份数据各说各话时，**范围判定以注册表为准**。
 */
function platformOf(id: string): { name: string; entry: platforms.PlatformEntry } | null {
  const m = id.match(/^host_cli:([^@]+)@/);
  if (!m) return null;
  const entry = platforms.load()?.platforms?.[m[1]];
  return entry ? { name: m[1], entry } : null;
}

/** 实测一条依赖。只回答"现在能不能找到、版本对不对"，不改账本。 */
export interface CheckOptions {
  /** 已安装 service 真正依赖的宿主（host → service id 列表）。
   *  只有被 service 依赖时才把「缺宿主」升为 fail：渲染不需要宿主，运行（且真有服务跑在上面）才需要。 */
  requiredHosts?: Map<string, string[]>;
}

export function check(e: DepEntry, opts: CheckOptions = {}): DepCheck {
  const required = e.role === "required";
  // 可选依赖缺失 ≠ 不健康：记 note，不拉红；required 缺失才 fail。
  // 例外：host_cli 缺宿主默认**最多 warn**（2026-11-18 用户定）——渲染不需要宿主，运行才需要；
  // 但若已安装 service 真声明了该 host（entry.agent.host）→ 该服务跑不起来，升 fail。
  const missing = (why: string): DepCheck => {
    if (e.kind === "host_cli") {
      const name = e.id.match(/^host_cli:([^@]+)@/)?.[1];
      const svcs = name ? opts.requiredHosts?.get(name) : undefined;
      if (svcs?.length)
        return { id: e.id, status: "fail", detail: `${e.id}：${why}（被 service 依赖：${svcs.join(", ")}；装宿主或改 service 的 entry.agent.host）` };
      if (required)
        return { id: e.id, status: "warn", detail: `${e.id}：${why}（本机未装宿主：渲染不需要，运行需要；装好后重跑 dia doctor）` };
    }
    return required
      ? { id: e.id, status: "fail", detail: `${e.id}：${why}（required：此机运行需要它，装好后重跑 dia doctor）` }
      : { id: e.id, status: "ok", note: true, detail: `${e.id}：${why}（可选，未装）` };
  };

  if (e.kind === "host_cli" || e.kind === "npm") {
    const bin = binOf(e.id);
    if (!bin) return { id: e.id, status: "warn", detail: `${e.id}：id 里取不到命令名` };
    const raw = probeVersion(bin);
    if (!raw) {
      // platforms 注册表显式声明 supported=false ⇒ 本平台没这个宿主，不算缺陷
      const pe = e.kind === "host_cli" ? platformOf(e.id) : null;
      if (pe && !pe.entry.supported) {
        return { id: e.id, status: "ok", note: true, detail: `${e.id}：本平台不支持（platforms 注册表 supported=false，跳过）` };
      }
      return missing(`${bin} 不在 PATH`);
    }
    const actual = versionOf(raw);
    // host_cli：有平台声明就用 range 判（补丁/预发布演进不该反复报漂移）；否则退回登记版本匹配
    const pe = e.kind === "host_cli" ? platformOf(e.id) : null;
    if (pe?.entry.range && actual) {
      return platforms.satisfies(actual, pe.entry.range)
        ? { id: e.id, status: "ok", detail: `${e.id}：${raw}（platforms 范围 ${pe.entry.range}）` }
        : { id: e.id, status: "warn", detail: `${e.id}：实测 ${actual}，超出 platforms 支持范围 ${pe.entry.range}`, note: !required };
    }
    const want = parseSpec(e.version);
    if (actual && want && !matchesSpec(actual, want)) {
      return { id: e.id, status: "warn", detail: `${e.id}：实测 ${actual}，登记 ${e.version}`, note: !required };
    }
    return { id: e.id, status: "ok", detail: `${e.id}：${raw}` };
  }

  if (e.kind === "datastore" || e.kind === "bundle" || e.kind === "daemon") {
    const r = e.resolved ?? "";
    if (!r || r.includes("*") || r.startsWith("npm:") || r.startsWith("command:")) {
      return { id: e.id, status: "ok", detail: `${e.id}：无固定路径（跳过探测）` };
    }
    const path = expand(r.replace(/^link:/, ""));
    return existsSync(path)
      ? { id: e.id, status: "ok", detail: `${e.id}：${path}` }
      : missing(`${path} 不存在`);
  }

  return { id: e.id, status: "ok", detail: `${e.id}：kind=${e.kind} 无探测规则` };
}

export function checks(entries: DepEntry[], opts: CheckOptions = {}): DepCheck[] { return entries.map((e) => check(e, opts)); }

/** 汇总成一条 doctor 检查：required 缺失 = fail；版本/路径漂移、缺宿主 = warn；可选未装只记 note。 */
export function summary(entries: DepEntry[], opts: CheckOptions = {}): { status: "ok" | "warn" | "fail"; detail: string } {
  const rows = checks(entries, opts);
  const fail = rows.filter((r) => r.status === "fail");
  const warn = rows.filter((r) => r.status === "warn");
  const notes = rows.filter((r) => r.note);
  const bad = [...fail, ...warn];
  const parts = [`${rows.length} 条`];
  if (fail.length) parts.push(`缺 ${fail.length}`);
  if (warn.length) parts.push(`告警 ${warn.length}`);
  if (notes.length) parts.push(`可选未装 ${notes.length}`);
  const detail = bad.length
    ? `${parts.join("，")}：${bad.slice(0, 3).map((r) => r.id).join(", ")}${bad.length > 3 ? " …" : ""}`
    : rows.length ? `${rows.length} 条一致${notes.length ? `（可选未装 ${notes.length}）` : ""}` : "无登记";
  return { status: fail.length ? "fail" : warn.length ? "warn" : "ok", detail };
}

/** 把一条登记追加到文件（只追加；供后续 `dia deps record` 用）。 */
export function append(entry: DepEntry, p?: string): string {
  const path = p ?? join(process.cwd(), "docs", "deps.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, prev.endsWith("\n") || !prev ? prev + line : prev + "\n" + line);
  try { chmodSync(path, 0o644); } catch { /* ignore */ }
  return path;
}
