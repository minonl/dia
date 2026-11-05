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

export function installedVersions(id: string): string[] {
  const dir = join(dataDir(), "personas", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((v) => statSync(join(dir, v)).isDirectory()).sort();
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
  try { return JSON.parse(readFileSync(join(dataDir(), "personas", id, version, "dia.lock"), "utf8")).commit; }
  catch { return undefined; }
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

export function history(id?: string, limit = 20): any[] {
  if (!existsSync(auditFile())) return [];
  const rows = readFileSync(auditFile(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = id ? rows.filter((r) => r.id === id) : rows;
  return filtered.slice(-limit).reverse();
}

function safeUser(): string {
  try { return userInfo().username; } catch { return process.env.USER || "unknown"; }
}
