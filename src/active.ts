// active.ts — 「生效版本」指针（决策 A，2026-10-30 用户拍板）
//
// 语义：多版本可以并存（DATA/personas/<id>/<ver>），但**只有一个生效**。
//   · 指针文件：<data>/state/active.json  { id: { version, commit, at, by, reason } }
//   · 审计流水：<data>/state/active.jsonl 每行一次切换（只追加）
//   · 未设置 → 回退「最新安装版本」（与旧行为兼容）
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import * as paths from "./paths.ts";

const dataDir = () => paths.diaHome();
const stateDir = () => join(dataDir(), "state");
const activeFile = () => join(stateDir(), "active.json");
const auditFile = () => join(stateDir(), "active.jsonl");

export interface ActiveEntry { version: string; commit?: string; at: string; by: string; reason?: string }
export type ActiveMap = Record<string, ActiveEntry>;

function readAll(): ActiveMap {
  try { return JSON.parse(readFileSync(activeFile(), "utf8")); } catch { return {}; }
}

/** 版本排序：先比 semver 主体，相同再比**安装时间**（槽位 `<ver>+g<sha>` 下字符串排序会把新槽位排到旧的后面前） */
function versionCmp(dir: string) {
  return (a: string, b: string) => {
    const core = (v: string) => v.split("+")[0].split(".").map((n) => Number(n) || 0);
    const ca = core(a), cb = core(b);
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
      const d = (ca[i] ?? 0) - (cb[i] ?? 0);
      if (d) return d;
    }
    const stamp = (v: string) => {
      // 与 commitOf 同口径：新布局 versions/<v> 优先，旧平铺 <v> 兜底
      const dirs = [join(dir, "versions", v), join(dir, v)];
      for (const d of dirs) {
        try {
          const lock = JSON.parse(readFileSync(join(d, "dia.lock"), "utf8"));
          if (lock?.installedAt) return Date.parse(lock.installedAt) || 0;
        } catch { /* 老槽位无 installedAt / 布局不符 → 尝试下一个 */ }
      }
      for (const d of dirs) {
        try { return statSync(d).mtimeMs; } catch { /* next */ }
      }
      return 0;
    };
    return stamp(a) - stamp(b);
  };
}

export function installedVersions(id: string): string[] {
  const dir = join(dataDir(), "personas", id);
  if (!existsSync(dir)) return [];
  const cmp = versionCmp(dir);
  const verRoot = join(dir, "versions");
  if (existsSync(verRoot)) return readdirSync(verRoot).filter((v) => statSync(join(verRoot, v)).isDirectory()).sort(cmp);
  const skip = new Set(["current", "latest", "data", "repo", "repo.git", "worktrees", "versions", ".lock"]);
  return readdirSync(dir).filter((v) => !skip.has(v) && !v.startsWith(".staging-") && statSync(join(dir, v)).isDirectory()).sort(cmp);
}

export function read(id: string): ActiveEntry | null {
  return readAll()[id] ?? null;
}

export function list(): ActiveMap {
  return readAll();
}

/** 生效版本：显式指针优先；没有指针时回退最新（兼容旧安装）。 */
export function effective(id: string): { version: string; source: "active" | "latest" } | null {
  const versions = installedVersions(id);
  if (!versions.length) return null;
  const a = read(id);
  if (a && versions.includes(a.version)) return { version: a.version, source: "active" };
  return { version: versions[versions.length - 1], source: "latest" };
}

function commitOf(id: string, version: string): string | undefined {
  // 两种安装布局并存：新布局 versions/<v>，旧布局平铺 <v>。
  // 只读平铺路径会让嵌套槽位在重指后丢掉 commit（scope/show 显示 ?）。
  for (const dir of [
    join(dataDir(), "personas", id, "versions", version),
    join(dataDir(), "personas", id, version),
  ]) {
    try { return JSON.parse(readFileSync(join(dir, "dia.lock"), "utf8")).commit; }
    catch { /* 尝试下一种布局 */ }
  }
  return undefined;
}

export function use(id: string, version: string | null, opts: { reason?: string; by?: string } = {}): { previous: string | null; current: ActiveEntry } {
  const versions = installedVersions(id);
  if (!versions.length) throw new Error(`E_NOT_INSTALLED: persona ${id}`);
  const target = version ?? versions[versions.length - 1];
  if (!versions.includes(target)) throw new Error(`E_VERSION: ${id}@${target} 未安装（已装：${versions.join(", ")}）`);

  const all = readAll();
  const previous = all[id]?.version ?? null;
  const entry: ActiveEntry = {
    version: target,
    commit: commitOf(id, target),
    at: new Date().toISOString(),
    by: opts.by || safeUser(),
    reason: opts.reason,
  };
  all[id] = entry;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(activeFile(), JSON.stringify(all, null, 1));
  appendFileSync(auditFile(), JSON.stringify({ id, ...entry, previous }) + "\n");
  return { previous, current: entry };
}

/** 清掉某个 persona 的生效指针（最后一个版本被删时用）；不会动审计流水。 */
export function clear(id: string): { previous: string | null } {
  const all = readAll();
  const previous = all[id]?.version ?? null;
  if (!all[id]) return { previous: null };
  delete all[id];
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(activeFile(), JSON.stringify(all, null, 1));
  return { previous };
}

export function history(id?: string, limit = 20): any[] {
  if (!existsSync(auditFile())) return [];
  const rows = readFileSync(auditFile(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = id ? rows.filter((r) => r.id === id) : rows;
  return filtered.slice(-limit).reverse();
}

function safeUser(): string {
  try { return userInfo().username; } catch { return process.env.USER || "unknown"; }
}
