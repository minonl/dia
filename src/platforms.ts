// platforms.ts — 平台注册表：单一事实源（docs/platforms/registry.json）的读取与版本判定
//
// 设计约束：
//   1. 数据只在 registry.json 里；人读视图由 dia doctor 派生，不写第二份。
//   2. 安装版从 <install>/registry/platforms.json 读；开发态回退到 cwd 的 docs 路径。
//   3. 只做"装没装 / 版本在不在范围"，不判定缺宿主为不健康（渲染不需要宿主，运行才需要）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "./paths.ts";

export interface PlatformEntry {
  supported: boolean;
  render: string | null;
  probe: string[];
  range: string | null;
  tested: string[];
  notes: string[];
}
export interface Registry { schema: number; updated?: string; platforms: Record<string, PlatformEntry> }

const home = () => process.env.DIA_HOME || homedir();

/** 候选路径顺序：显式 env > 安装目录 > 开发态 cwd。 */
export function registryCandidates(): string[] {
  const out: string[] = [];
  if (process.env.DIA_PLATFORMS_FILE) out.push(process.env.DIA_PLATFORMS_FILE);
  const install = paths.installDir();
  out.push(join(install, "registry", "platforms.json"));
  out.push(join(process.cwd(), "docs", "platforms", "registry.json"));
  return out;
}

export function registryPath(): string | null {
  return registryCandidates().find((p) => existsSync(p)) ?? null;
}

export function load(): Registry | null {
  const p = registryPath();
  if (!p) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as Registry;
    return r?.schema === 1 && r.platforms ? r : null;
  } catch { return null; }
}

/** 取版本号里的 x.y.z；带 v 前缀或预发布后缀都能吃。 */
export function versionOf(text: string): string | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** 支持简单约束：空格分隔的 `>=1.2.3` / `<2.0.0` / `=1.2.3`；空范围视为通过。 */
export function satisfies(version: string, range: string | null): boolean {
  if (!range) return true;
  const v = versionOf(version);
  if (!v) return false;
  return range.trim().split(/\s+/).every((part) => {
    const m = part.match(/^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)$/);
    if (!m) return false;
    const [, op = "=", target] = m;
    const c = cmp(v, target);
    switch (op) {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      default: return c === 0;
    }
  });
}

/** 直接执行二进制（不经 shell），失败即视为未安装。 */
export function probe(bin: string, entry: PlatformEntry): string | null {
  try {
    const out = execFileSync(bin, entry.probe, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n")[0] || null;
  } catch { return null; }
}

export interface PlatformCheck { name: string; status: "ok" | "warn"; detail: string }

/** 派生视图：按注册表逐个探测，返回 doctor 可直接用的检查项。 */
export function checks(reg: Registry): PlatformCheck[] {
  return Object.entries(reg.platforms)
    .filter(([, e]) => e.supported)
    .map(([name, e]) => {
      const raw = probe(name, e);
      if (!raw) return { name: `platform:${name}`, status: "warn" as const, detail: "未安装（渲染不需要，运行需要）" };
      const v = versionOf(raw);
      if (v && !satisfies(v, e.range)) {
        return { name: `platform:${name}`, status: "warn" as const, detail: `${raw}（超出支持范围 ${e.range}）` };
      }
      return { name: `platform:${name}`, status: "ok" as const, detail: `${raw}${e.range ? `（支持 ${e.range}）` : ""}` };
    });
}
