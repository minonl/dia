// cache.ts — 缓存治理（`~/.dia/cache`）
//
// 口径（2026-11-18 用户定）：
//   1. cache 是**派生数据**（git clone / 索引），默认可删——删了下次用时重建，不算事故。
//   2. 所以 cache **不承担保留语义**：要长期留的东西必须备份到 cache 之外（`git bundle` / 备份盘 / 仓库）。
//   3. 唯一不可再生的是「本地独有的内容」：未提交改动、只存在于本地分支的提交。
//      → `gc` 默认不碰这类条目（跳过并提示备份），只有显式 `--force` 才删。
//   4. 判定不了（git 命令失败/超时）按**本地独有**处理：宁可少删，不可误删（fail-closed）。
//   5. gc 默认 dry-run：先看清要删什么，再 `--apply`。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "./paths.ts";

export interface GitInfo {
  remote: string | null;
  head: string | null;
  dirty: boolean;
  unpushed: number;
  /** git 状态判定失败（仓库损坏/超时）——按本地独有处理，默认不删 */
  unknown?: boolean;
}
export interface CacheEntry {
  /** 相对键：`src/<sha1-12>` / `<root>/<name>` */
  key: string;
  path: string;
  /** 顶层分类：src / ingest / … */
  root: string;
  bytes: number;
  mtime: string;
  git?: GitInfo;
  /** 仍被已安装 persona/kit 引用的标记（`<id>@<ver>`）；空 = 无引用 */
  referencedBy: string[];
  /** 有本地独有内容（dirty / 未推送 / git 状态未知） */
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

/** 远程地址脱敏：去掉 userinfo（token/密码）与 query/fragment，避免 --json 泄漏凭据。 */
export function sanitizeRemote(url: string | null): string | null {
  if (!url) return null;
  const bare = url.split("?")[0].split("#")[0];
  return bare.replace(/^([a-z+]+:\/\/)[^/@]+@/i, "$1***@");
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
  // 判定不了就不猜「干净」：宁可当本地独有（gc 跳过），也不误删
  const unknown = !head || status === null || count === null;
  const unpushed = count === null ? 0 : Number(count) || 0;
  return {
    remote: sanitizeRemote(remote),
    head,
    dirty: !!status && status.length > 0,
    unpushed,
    ...(unknown ? { unknown: true } : {}),
  };
}

/** 版本目录枚举：兼容 `<id>/<ver>`（旧平铺）与 `<id>/versions/<ver>`（新布局）。 */
function versionDirsOf(idDir: string): string[] {
  const out: string[] = [];
  const nested = join(idDir, "versions");
  if (existsSync(nested)) {
    try {
      for (const v of readdirSync(nested)) {
        const p = join(nested, v);
        try { if (statSync(p).isDirectory()) out.push(p); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  try {
    for (const v of readdirSync(idDir)) {
      if (v === "versions" || v.startsWith(".")) continue;
      const p = join(idDir, v);
      try { if (statSync(p).isDirectory()) out.push(p); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return out;
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
  const scan = (root: string, lockName: string, prefix: (id: string, ver: string) => string) => {
    if (!existsSync(root)) return;
    for (const id of readdirSync(root)) {
      if (id.startsWith(".")) continue;
      const idDir = join(root, id);
      try { if (!statSync(idDir).isDirectory()) continue; } catch { continue; }
      for (const verDir of versionDirsOf(idDir)) {
        try {
          const lock = JSON.parse(readFileSync(join(verDir, lockName), "utf8"));
          add(lock.source, prefix(id, verDir.split(/[\\/]/).pop() as string));
        } catch { /* 无 lock（安装未完成）忽略 */ }
      }
    }
  };
  scan(paths.personasDir(), "dia.lock", (id, ver) => `${id}@${ver}`);
  scan(join(paths.diaHome(), "kits"), "kit.lock", (id, ver) => `kit:${id}@${ver}`);
  return out;
}

/** 缓存根：`src` 用 srcCacheDir()（尊重 DIA_CACHE_DIR），其余取数据根 cache/ 下的顶层目录。 */
export function roots(): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  const srcDir = paths.srcCacheDir();
  if (existsSync(srcDir)) out.push({ name: "src", dir: srcDir });
  const base = paths.cacheRoot();
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      if (name === "src" || name.startsWith(".")) continue;
      const dir = join(base, name);
      try { if (statSync(dir).isDirectory()) out.push({ name, dir }); } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * 列缓存条目（只读）。
 * 条目 = 根目录下的**子目录**；根本身永不作为条目（否则混进一个 `.DS_Store` 就会把整个 root 当条目删掉）。
 */
export function list(root?: string): CacheEntry[] {
  const refs = referencedKeys();
  const out: CacheEntry[] = [];
  for (const r of roots()) {
    if (root && r.name !== root) continue;
    let children: string[] = [];
    try { children = readdirSync(r.dir); } catch { continue; }
    for (const child of children) {
      if (child.startsWith(".")) continue; // .DS_Store/.lock 等杂项：永不当作条目
      const dir = join(r.dir, child);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const g = entryGit(dir);
      out.push({
        key: `${r.name}/${child}`,
        path: dir,
        root: r.name,
        bytes: dirBytes(dir),
        mtime: new Date(statSync(dir).mtimeMs).toISOString(),
        git: g,
        referencedBy: refs.get(child) ?? [],
        localOnly: !!g && (!!g.unknown || g.dirty || g.unpushed > 0),
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
  /** 只清某个缓存根（src / …） */
  root?: string;
}

/**
 * 缓存回收：默认 dry-run。
 * 跳过规则（按优先级）：
 *   1. 被已安装 persona/kit 引用 → 跳过（除非 `referenced: true`，删了下次重 clone）
 *   2. 有本地独有内容（dirty / 未推送 / git 状态未知）→ 跳过并提示备份（除非 `force: true`）
 */
export function gc(opts: GcOptions = {}): GcResult {
  const entries = list(opts.root);
  const removed: CacheEntry[] = [];
  const skipped: { entry: CacheEntry; reason: string }[] = [];
  let freedBytes = 0;
  for (const e of entries) {
    if (e.referencedBy.length && !opts.referenced) {
      skipped.push({ entry: e, reason: `被引用：${e.referencedBy.join(", ")}（--referenced 可删）` });
      continue;
    }
    if (e.localOnly && !opts.force) {
      const why = [
        e.git?.unknown ? "git 状态无法判定" : "",
        e.git?.dirty ? "有未提交改动" : "",
        e.git?.unpushed ? `${e.git.unpushed} 个未推送提交` : "",
      ].filter(Boolean).join("、");
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
