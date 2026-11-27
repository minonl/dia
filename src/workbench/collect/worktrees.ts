// dia workbench —— worktree 采集器（多仓顶层）
//
// 设计：docs/design/workbench.md §3.3 / §4.3 / §9.2
// 约定：
//   · 仓来源 = 会话 cwd 命中的 git 根（去重）；不猜「会话在用哪棵 wt」（§4.5）
//   · `git worktree list --porcelain` 全量（便宜）；`git status` 只对「有 claim」或 depth=full 执行
//   · dirty 未检查时写 null + dirty_state:"not_checked"，不写 0 假装干净
//   · merged_to_main / behind_main 只在已检查时 best-effort，失败不抛

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import * as claimsStore from "../../claims.ts";
import type { ClaimView, RepoView, SourceStatus, WorktreeView } from "../schema.ts";

export interface WorktreeCollectOpts {
  /** 会话 cwd（去重后用于发现 git 根） */
  cwds?: string[];
  /** 显式仓根（--cwd 覆盖 / 测试注入） */
  repoPaths?: string[];
  depth?: "fast" | "full";
  now?: Date;
  /** 注入 claim（缺省读 claims.list() 的活跃租约） */
  claims?: claimsStore.Claim[];
  /** 单条 git 命令超时（默认 1500ms，与 config.collect.git_status_timeout_ms 一致） */
  timeoutMs?: number;
  /** 最多解析多少个 cwd（防御：极端 cwd 数量拖慢快照；fs 探测后单 cwd 只花一次 stat） */
  maxCwds?: number;
}

export interface WorktreeCollectResult {
  worktrees: { schema_v: 1; repos: RepoView[] };
  source: SourceStatus;
  /** 命中的 git 根（供告警/调试） */
  roots: string[];
}

const DEFAULT_TIMEOUT = 1500;

function git(cwd: string, args: string[], timeoutMs: number): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** 远端 URL → 完整 group 路径 slug（org/group/project-a）。 */
export function slugFromRemote(url: string): string | null {
  let s = String(url || "").trim();
  if (!s) return null;
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  let path: string | null = null;
  const scp = s.match(/^[^/@\s]+@[^/:\s]+:(.+)$/); // git@host:group/repo
  if (scp) path = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { path = new URL(s).pathname; } catch { path = null; }
  } else if (s.includes(":")) {
    // host:group/repo（无 scheme 无 user）
    const i = s.indexOf(":");
    path = s.slice(i + 1);
  } else path = s; // 纯相对/绝对路径
  if (path == null) return null;
  const segs = path.split("/").filter(Boolean);
  if (!segs.length) return null;
  if (segs.length < 2) return `local:${segs[segs.length - 1]}`;
  return segs.join("/");
}

/** 从 cwd 往上找 .git（fs 探测，比 spawn git 便宜一个数量级）。 */
function candidateRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 把任意 worktree 根收敛到「主 checkout 根」（同仓多棵 wt → 同一个 repo）。
 *  优先 fs 解析（.git 目录 / .git 文件的 gitdir 指针），失败才问 git。 */
function mainRootOf(root: string, timeoutMs: number): { main: string; common: string | null; top: string } {
  const top = realpathSafe(root);
  const dotGit = join(top, ".git");
  let common: string | null = null;
  try {
    const st = lstatSync(dotGit);
    if (st.isDirectory()) common = dotGit;
    else if (st.isFile()) {
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitdir = resolve(top, m[1].trim());
        const candidate = dirname(dirname(gitdir)); // <main>/.git/worktrees/<name> → <main>/.git
        if (basename(candidate) === ".git") common = candidate;
      }
    }
  } catch {
    common = null;
  }
  if (common) {
    return { main: basename(common) === ".git" ? dirname(common) : top, common, top };
  }
  const out = git(top, ["rev-parse", "--show-toplevel", "--git-common-dir"], timeoutMs);
  if (!out) return { main: top, common: null, top };
  const [topLine, commonLine] = out.split("\n");
  const gitTop = resolve(topLine || top);
  const gitCommon = commonLine ? resolve(gitTop, commonLine) : null;
  const main = gitCommon && basename(gitCommon) === ".git" ? dirname(gitCommon) : gitTop;
  return { main, common: gitCommon, top: gitTop };
}

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** 直接读 <common>/config 的 [remote "origin"] url（省一次 spawn）；读不到返回 null。 */
function originUrlFromConfig(common: string | null): string | null {
  if (!common) return null;
  try {
    const text = readFileSync(join(common, "config"), "utf8");
    let inOrigin = false;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("[")) { inOrigin = /^\[remote\s+"origin"\]$/i.test(line); continue; }
      if (!inOrigin) continue;
      const m = line.match(/^url\s*=\s*(.+)$/i);
      if (m) return m[1].trim();
    }
  } catch { /* ignore */ }
  return null;
}

function originUrl(root: { main: string; common: string | null }, timeoutMs: number): string | null {
  return originUrlFromConfig(root.common) || git(root.main, ["remote", "get-url", "origin"], timeoutMs);
}

export interface RepoRoot { path: string; repo: string }

/** 会话 cwd → git 根（规范化）+ 完整 group 路径 slug。 */
export function discoverRepos(cwds: string[], opts: { timeoutMs?: number; maxCwds?: number } = {}): RepoRoot[] {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const limit = opts.maxCwds ?? 5000;
  const byPath = new Map<string, RepoRoot>();
  // 同一棵 wt 下的 N 个 cwd 只 spawn 一次 git（本机实测这是 fast 路径的主要成本）
  const byCandidate = new Map<string, RepoRoot | null>();
  const seenCwd = new Set<string>();
  let scanned = 0;
  for (const raw of cwds) {
    if (!raw || scanned >= limit) continue;
    const cwd = resolve(raw);
    if (seenCwd.has(cwd)) continue;
    seenCwd.add(cwd);
    if (!existsSync(cwd)) continue;
    scanned++;
    const cand = candidateRoot(cwd);
    if (!cand) continue;
    let hit = byCandidate.get(cand);
    if (hit === undefined) {
      // 收敛到主 checkout（链接 wt 也归到同一仓），拿不到就退化为候选根
      const mr = mainRootOf(cand, timeoutMs);
      const url = originUrl(mr, timeoutMs);
      hit = { path: mr.main, repo: (url ? slugFromRemote(url) : null) || `local:${basename(mr.main)}` };
      byCandidate.set(cand, hit);
    }
    if (!hit) continue;
    if (!byPath.has(hit.path)) byPath.set(hit.path, hit);
  }
  return [...byPath.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

export interface PorcelainWorktree {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  prunable: boolean;
  bare: boolean;
}

/** 解析 `git worktree list --porcelain`。 */
export function parseWorktreeList(out: string): PorcelainWorktree[] {
  const rows: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) rows.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), head: "", branch: "", detached: false, prunable: false, bare: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  if (cur) rows.push(cur);
  return rows.filter((r) => r.path && !r.bare);
}

/** claim 归属：claim.path 相对 git 根 → 绝对路径 → 按最长前缀落到 worktree。 */
function claimWorktree(abs: string, paths: string[]): string | null {
  let hit: string | null = null;
  for (const p of paths) {
    if (abs === p || abs.startsWith(p.endsWith(sep) ? p : p + sep)) {
      if (!hit || p.length > hit.length) hit = p;
    }
  }
  return hit;
}

function claimView(c: claimsStore.Claim): ClaimView {
  return { id: c.id, holder: c.holder, lease: "exclusive", expires_at: c.expires_at };
}

/** main 分支引用（本地优先），单次 for-each-ref 同时拿 ref 与 sha。 */
function resolveMain(repoPath: string, timeoutMs: number): { ref: string; head: string } | null {
  const order: Array<[string, string]> = [
    ["refs/heads/main", "main"],
    ["refs/remotes/origin/main", "origin/main"],
    ["refs/heads/master", "master"],
    ["refs/remotes/origin/master", "origin/master"],
  ];
  const out = git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)", ...order.map(([r]) => r)], timeoutMs);
  if (!out) return null;
  const sha = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [ref, hash] = line.trim().split(/\s+/);
    if (ref && hash) sha.set(ref, hash);
  }
  for (const [ref, short] of order) {
    const hash = sha.get(ref);
    if (hash) return { ref: short, head: hash };
  }
  return null;
}

export function collectWorktrees(opts: WorktreeCollectOpts = {}): WorktreeCollectResult {
  const started = Date.now();
  const depth = opts.depth || "fast";
  const now = opts.now || new Date();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const repos: RepoView[] = [];
  const roots: string[] = [];
  let claims: claimsStore.Claim[] = [];
  try {
    claims = opts.claims ?? claimsStore.list({ now });
  } catch {
    claims = [];
  }
  const active = claims.filter((c) => {
    try { return claimsStore.isActive(c, now.getTime()); } catch { return false; }
  });

  const explicit: RepoRoot[] = (opts.repoPaths || []).map((p) => {
    const raw = resolve(p);
    // 收敛到主 checkout（软链 / macOS /var → /private/var 也在 rev-parse 里规范化）
    const mr = mainRootOf(raw, timeoutMs);
    const url = originUrl(mr, timeoutMs);
    return { path: mr.main, repo: (url ? slugFromRemote(url) : null) || `local:${basename(mr.main)}` };
  });
  const discovered = discoverRepos(opts.cwds || [], { timeoutMs });
  const byPath = new Map<string, RepoRoot>();
  for (const r of [...explicit, ...discovered]) if (!byPath.has(r.path)) byPath.set(r.path, r);

  for (const root of [...byPath.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path))) {
    const listing = git(root.path, ["worktree", "list", "--porcelain"], timeoutMs);
    if (listing == null) continue;
    roots.push(root.path);
    const wts = parseWorktreeList(listing);
    if (!wts.length) continue;
    const paths = wts.map((w) => realpathSafe(w.path));
    const mainPath = paths[0]; // git worktree list 首条 = 主 checkout

    // 该仓的活跃 claim（scope 可能是完整 slug，也可能是旧的两段式 group/project-a）
    const repoClaims = active.filter((c) => c.scope === root.repo || root.repo.endsWith("/" + c.scope) || c.scope === `local:${basename(mainPath)}`);
    const claimsByWt = new Map<string, claimsStore.Claim[]>();
    for (const c of repoClaims) {
      const abs = resolve(mainPath, c.path);
      const owner = claimWorktree(abs, paths) || mainPath;
      if (!owner) continue;
      const list = claimsByWt.get(owner) || [];
      list.push(c);
      claimsByWt.set(owner, list);
    }

    // main ref：本地 main 优先，其次 origin/main（best-effort，一次 for-each-ref 拿全）
    // 没有任何 worktree 需要检查时（fast 且无 claim）完全跳过，省掉每仓一次 spawn
    const needRefs = wts.some((w) => claimsByWt.has(realpathSafe(w.path))) || depth === "full";
    const main = needRefs ? resolveMain(root.path, timeoutMs) : null;
    const mainRef = main?.ref || null;
    const mainHead = main?.head || null;

    const views: WorktreeView[] = [];
    for (const w of wts) {
      const abs = realpathSafe(w.path);
      const held = claimsByWt.get(abs) || [];
      const claimHeld = held.length > 0;
      const checked = claimHeld || depth === "full";
      const isMain = abs === mainPath;

      let dirty: number | null = null;
      let dirtyState: WorktreeView["dirty_state"] = "not_checked";
      if (checked) {
        const out = git(abs, ["status", "--porcelain", "--untracked-files=no"], timeoutMs);
        if (out != null) {
          dirty = out ? out.split("\n").filter(Boolean).length : 0;
          dirtyState = "checked";
        }
      }

      let mergedToMain = false;
      let behindMain: number | undefined;
      if (dirtyState === "checked" && mainRef && w.head) {
        if (mainHead && w.head !== mainHead) {
          // exit 0 = head 是 main 的祖先（已合并）
          mergedToMain = git(abs, ["merge-base", "--is-ancestor", w.head, mainRef], timeoutMs) != null;
        }
        const behind = git(abs, ["rev-list", "--count", `${w.head}..${mainRef}`], timeoutMs);
        if (behind != null) {
          const n = Number.parseInt(behind, 10);
          if (Number.isFinite(n) && n >= 0) behindMain = n;
        }
      }

      const flags: WorktreeView["flags"] = [];
      if (claimHeld) flags.push("claimed");
      else flags.push("orphan");
      if (held.length > 1) flags.push("shared");
      if (w.prunable) flags.push("merged-prunable");
      if (w.detached) flags.push("detached");
      if (dirtyState === "not_checked") flags.push("not_checked");
      if (dirtyState === "checked" && isMain && (dirty || 0) > 0) flags.push("main-dirty");
      if (behindMain && behindMain > 0) flags.push("behind");

      views.push({
        path: abs,
        branch: w.branch || (w.detached ? "(detached)" : ""),
        head: w.head.slice(0, 7),
        dirty,
        dirty_state: dirtyState,
        prunable: w.prunable,
        merged_to_main: mergedToMain,
        behind_main: behindMain,
        claim: claimHeld ? claimView(held[0]) : undefined,
        flags,
      });
    }
    views.sort((a, b) => a.path.localeCompare(b.path));
    repos.push({ repo: root.repo, repo_path: mainPath, worktrees: views });
  }

  const total = repos.reduce((n, r) => n + r.worktrees.length, 0);
  return {
    worktrees: { schema_v: 1, repos },
    source: {
      status: roots.length || explicit.length ? "ok" : "skipped",
      duration_ms: Date.now() - started,
      detail: `${repos.length} repos / ${total} worktrees${opts.cwds?.length ? ` (cwds ${opts.cwds.length})` : ""}`,
    },
    roots,
  };
}
