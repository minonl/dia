// cache.ts — 缓存治理（`~/.dia/cache`）
//
// 口径（2026-11-18 用户定）：
//   1. cache 是**派生数据**（git clone / 索引），默认可删——删了下次用时重建，不算事故。
//   2. 所以 cache **不承担保留语义**：要长期留的东西必须备份到 cache 之外（`git bundle` / 备份盘 / 仓库）。
//   3. 唯一不可再生的是「本地独有的内容」：未提交改动、只存在于本地分支的提交。
//      → `gc` 默认不碰这类条目（跳过并提示备份），只有显式 `--force` 才删。
//   4. gc 默认 dry-run：先看清要删什么，再 `--apply`。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "./paths.ts";

export interface GitInfo { remote: string | null; head: string | null; dirty: boolean; unpushed: number }
export interface CacheEntry {
  /** 顶层内相对键：`src/<sha1-12>` / 顶层目录名 */
  key: string;
  path: string;
  /** 顶层分类：src / ingest / … */
  root: string;
  bytes: number;
  mtime: string;
  git?: GitInfo;
  /** 仍被已安装 persona/kit 引用的标记（`<id>@<ver>`）；空 = 无引用 */
  referencedBy: string[];
  /** 有本地独有内容（dirty 或未推送提交） */
  localOnly: boolean;
}
export interface GcResult {
  entries: CacheEntry[];
  removed: CacheEntry[];
  skipped: { entry: CacheEntry; reason: string }[];
  freedBytes: number;
}

/** 与 persona.ts / kit.ts 的 clone 缓存键同一算法：sha1(url).slice(0,12)。 */
export function cacheKeyOfSource(source: string): string {
  const url = source.replace(/^git\+/, "");
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (p: string, depth: number) => {
    if (depth > 12) return;
    let list: string[];
    try { list = readdirSync(p); } catch { return; }
    for (const name of list) {
      const child = join(p, name);
      try {
        const st = statSync(child);
        if (st.isDirectory()) walk(child, depth + 1);
        else total += st.size;
      } catch { /* 并发删除/权限：跳过 */ }
    }
  };
  walk(dir, 0);
  return total;
}

function entryGit(dir: string): GitInfo | undefined {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const remote = git(dir, ["config", "--get", "remote.origin.url"]);
  const head = git(dir, ["rev-parse", "--short", "HEAD"]);
  const status = git(dir, ["status", "--porcelain"]);
  const count = git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const unpushed = count === null ? 0 : Number(count) || 0;
  return { remote, head, dirty: !!status && status.length > 0, unpushed };
}

/** 已安装资产（persona / kit）引用的缓存键 → `id@ver` 列表。 */
export function referencedKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (source: unknown, label: string) => {
    if (typeof source !== "string" || !source) return;
    if (!/^(git\+)?(https?:\/\/|git@)/.test(source)) return;
    const key = cacheKeyOfSource(source);
    out.set(key, [...(out.get(key) ?? []), label]);
  };
  // persona：<personas>/<id>/<ver>/dia.lock
  const personas = paths.personasDir();
  if (existsSync(personas)) {
    for (const id of readdirSync(personas)) {
      const idDir = join(personas, id);
      let versions: string[] = [];
      try { versions = readdirSync(idDir); } catch { continue; }
      for (const ver of versions) {
        try {
          const lock = JSON.parse(readFileSync(join(idDir, ver, "dia.lock"), "utf8"));
          add(lock.source, `${id}@${ver}`);
        } catch { /* 无 lock（安装未完成）忽略 */ }
      }
    }
  }
  // kit：<kits>/<id>/<ver>/kit.lock（lock 里目前没有 source，留好口子）
  const kits = join(paths.diaHome(), "kits");
  if (existsSync(kits)) {
    for (const id of readdirSync(kits)) {
      if (id.startsWith(".")) continue;
      const idDir = join(kits, id);
      let versions: string[] = [];
      try { versions = readdirSync(idDir); } catch { continue; }
      for (const ver of versions) {
        try {
          const lock = JSON.parse(readFileSync(join(idDir, ver, "kit.lock"), "utf8"));
          add(lock.source, `kit:${id}@${ver}`);
        } catch { /* 忽略 */ }
      }
    }
  }
  return out;
}

/** 列缓存条目（只读）。`root` 为空 = 全量。 */
export function list(root?: string): CacheEntry[] {
  const base = paths.cacheRoot();
  if (!existsSync(base)) return [];
  const refs = referencedKeys();
  const out: CacheEntry[] = [];
  const roots = root ? [root] : readdirSync(base).filter((n) => !n.startsWith("."));
  for (const r of roots) {
    const rootDir = join(base, r);
    let st;
    try { st = statSync(rootDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    // 约定：`<root>/<key>` 两层；root 下若直接是条目则也能认（顶层即条目）
    let children: string[] = [];
    try { children = readdirSync(rootDir); } catch { children = []; }
    const nested = children.length > 0 && children.every((c) => {
      try { return statSync(join(rootDir, c)).isDirectory(); } catch { return false; }
    });
    const items = nested ? children.map((c) => ({ key: `${r}/${c}`, dir: join(rootDir, c) })) : [{ key: r, dir: rootDir }];
    for (const it of items) {
      const g = entryGit(it.dir);
      const key = it.key.split("/").pop() as string;
      const referencedBy = refs.get(key) ?? [];
      out.push({
        key: it.key,
        path: it.dir,
        root: r,
        bytes: dirBytes(it.dir),
        mtime: new Date(statSync(it.dir).mtimeMs).toISOString(),
        git: g,
        referencedBy,
        localOnly: !!g && (g.dirty || g.unpushed > 0),
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface GcOptions {
  /** 真删；否则 dry-run */
  apply?: boolean;
  /** 连「有本地独有内容」的条目也删 */
  force?: boolean;
  /** 连「仍被已安装资产引用」的条目也删 */
  referenced?: boolean;
}

/**
 * 缓存回收：默认 dry-run。
 * 跳过规则（按优先级）：
 *   1. 被已安装 persona/kit 引用 → 跳过（除非 `referenced: true`，删了下次重clone）
 *   2. 有本地独有内容（dirty / 未推送）→ 跳过并提示备份（除非 `force: true`）
 */
export function gc(opts: GcOptions = {}): GcResult {
  const entries = list();
  const removed: CacheEntry[] = [];
  const skipped: { entry: CacheEntry; reason: string }[] = [];
  let freedBytes = 0;
  for (const e of entries) {
    if (e.referencedBy.length && !opts.referenced) {
      skipped.push({ entry: e, reason: `被引用：${e.referencedBy.join(", ")}（--referenced 可删）` });
      continue;
    }
    if (e.localOnly && !opts.force) {
      const why = [e.git?.dirty ? "有未提交改动" : "", e.git?.unpushed ? `${e.git.unpushed} 个未推送提交` : ""].filter(Boolean).join("、");
      skipped.push({ entry: e, reason: `本地独有内容（${why}）：先备份再删（--force 强制）` });
      continue;
    }
    if (opts.apply) {
      try { rmSync(e.path, { recursive: true, force: true }); } catch (err: any) {
        skipped.push({ entry: e, reason: `删除失败：${err?.message || err}` });
        continue;
      }
    }
    removed.push(e);
    freedBytes += e.bytes;
  }
  return { entries, removed, skipped, freedBytes };
}

/** 人类可读体积（doctor / CLI 输出用）。 */
export function human(bytes: number): string {
  const units = ["B", "K", "M", "G"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}
