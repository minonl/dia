// doctor.ts — 组合自检：把各能力的「是否健康」收成一个入口
//
// 只做组合与判定，不实现检查逻辑：
//   persona verify / kit verify / default_agent / kb 索引 / wt 包 / job 包
// 退出码：0 全绿；1 有 warn；2 有 fail（便于脚本与 CI 判定）
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import * as persona from "./persona.ts";
import * as defaultMsg from "./default-msg.ts";
import * as kit from "./kit.ts";
import * as scope from "./scope.ts";
import * as active from "./active.ts";
import * as dsh from "./dsh.ts";
import * as platforms from "./platforms.ts";
import * as deps from "./deps.ts";
import * as paths from "./paths.ts";
import * as job from "./job.ts";
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
function collabObserverCheck(): Check {
  const name = "collab.observer";
  // 未启用 dia-msg 的机器不该因为「没有观察器」被标黄
  try { if (!defaultMsg.status(undefined).enabled) return { name, status: "ok", detail: "dia-msg 未启用（跳过）" }; } catch { /* ignore */ }
  const boardPath = join(paths.diaHome(), "collab", "state", "board.json");
  const statePath = join(paths.diaHome(), "collab", "state");
  let tasks: Record<string, any> = {};
  try { tasks = JSON.parse(readFileSync(join(job.jobRootResolved(), "tasks", "registry.json"), "utf8"))?.tasks || {}; } catch { /* none */ }
  const key = Object.keys(tasks).find((k) => k === "collab-observe" || k.endsWith(".collab-observe"));
  if (!key) return { name, status: "warn", detail: '未注册定时（dia job install collab-observe --interval 300 --cmd "dia collab observe"）' };
  const reg = tasks[key] || {};
  let board: any = null;
  try { board = JSON.parse(readFileSync(boardPath, "utf8")); } catch { /* none */ }
  if (!board) return { name, status: "warn", detail: "定时已注册但 board 未生成（先跑 dia collab observe）" };

  const issues: string[] = [];
  try { const m = statSync(boardPath).mode & 0o777; if (m & 0o077) issues.push(`board 权限 ${m.toString(8)}（应 600）`); } catch { /* ignore */ }
  try { const m = statSync(statePath).mode & 0o777; if (m & 0o077) issues.push(`state 目录权限 ${m.toString(8)}（应 700）`); } catch { /* ignore */ }

  const interval = Number(String(reg.interval ?? "").trim()) || 300;
  if (typeof board.interval_s === "number" && board.interval_s !== interval) {
    issues.push(`interval 不一致：board=${board.interval_s}s / job=${interval}s`);
  }
  const age = Date.now() - Date.parse(board.generated_at);
  const ttl = Math.min(900_000, Math.max(interval * 2000, interval * 1000 + 60_000));
  if (!Number.isFinite(age) || age < -5_000) issues.push("board 时间戳异常（未来/不可解析）");
  else if (age > ttl) issues.push(`board ${Math.round(age / 60000)} 分钟未刷新（> ${Math.round(ttl / 1000)}s）`);

  return { name, status: issues.length ? "warn" : "ok", detail: issues[0] ?? `job=${interval}s · board ${Math.round(Math.max(0, age) / 60000)} 分钟前` };
}

export function quoteArg(v: string): string {
  return /^[\w.@%+=:,\/-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

/** 路径是否落在 npm 全局包 @minonl/dia 里（包管理器无关：pnpm/yarn/bun 也走 node_modules）。 */
export function npmOwnedPath(p: string): boolean {
  return /(^|[\\/])node_modules[\\/]@minonl[\\/]dia([\\/]|$)/.test(p);
}

/**
 * shim 形态的包管理器全局安装：pnpm / yarn-berry 在全局 bin 放的是**脚本**（不是软链），
 * 内容里带包路径 —— 只看 realpath 会把这类安装误判成「脚本安装」。
 */
export function pkgShimPath(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > 1024 * 1024) return false;
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return /@minonl\/dia|node_modules\/(@minonl\/)?dia\//.test(buf.subarray(0, n).toString("utf8"));
    } finally { closeSync(fd); }
  } catch { return false; }
}

/** 已知包管理器全局 bin 目录（volta 的同名二进制 shim 不含包路径，只能靠目录归属判断）。 */
export function pkgBinDirOwned(p: string): boolean {
  const d = realOrSelf(dirname(p));
  const home = homedir();
  const known = [
    join(home, ".volta/bin"), join(home, ".bun/bin"), join(home, ".yarn/bin"),
    join(home, ".pnpm-global/bin"), join(home, ".local/share/pnpm"), join(home, ".npm-global/bin"),
    process.env.PNPM_HOME, process.env.YARN_GLOBAL_FOLDER,
    process.env.VOLTA_HOME ? join(process.env.VOLTA_HOME, "bin") : "",
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin") : "",
  ].filter(Boolean);
  return known.some((k) => realOrSelf(k) === d);
}

/** 包管理器全局安装（软链形态看 realpath，shim 形态看内容，volta 看 bin 目录归属）。 */
export function pkgOwnedPath(p: string): boolean {
  return npmOwnedPath(p) || pkgShimPath(p) || pkgBinDirOwned(p);
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * `command -v dia` 的等价实现：PATH 里第一个可执行的 `dia`。
 * 脚本里看不到 shell 函数/alias，因此这里也只认文件；找不到返回 null（调用方降级）。
 */
export function whichDia(pathEnv: string = process.env.PATH || ""): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "dia");
    try {
      const st = statSync(cand); // 跟随软链：断链会抛错 → 该目录跳过
      if (!st.isFile()) continue;
      if (process.platform !== "win32" && (st.mode & 0o111) === 0) continue;
      return cand;
    } catch { /* 该目录没有可用的 dia */ }
  }
  return null;
}

/**
 * install_shadow：脚本安装与包管理器全局安装「互相遮挡」的可见化。
 * 判据是**双向一致**——installDir() 与 `command -v dia` 的真实路径必须同属包管理器安装或同属脚本安装。
 * 包管理器一致安装（install 与 PATH bin 都在 `node_modules/@minonl/dia` 下）必须 pass，不能误报。
 * bin 是 pnpm/yarn 的 shim 脚本时按内容识别（软链形态只看 realpath 会漏）。
 */
function installShadowCheck(): Check {
  const name = "install_shadow";
  const install = paths.installDir();
  const installNpm = npmOwnedPath(realOrSelf(install));
  // 源码 checkout（bun run dev / bun packages/cli/src/index.ts）不是「安装」，比出来只会误报：
  // 跳过一致性判定，只在真的安装根（npm 包或脚本安装有 install.json）上判。
  if (!installNpm && !existsSync(join(install, "install.json"))) {
    return { name, status: "ok", detail: `源码运行（install=${install} 无 install.json，跳过一致性判定）` };
  }
  const bin = whichDia();
  if (!bin) return { name, status: "ok", detail: `PATH 中没有 dia（跳过一致性判定；install=${install}）` };
  const binReal = realOrSelf(bin);
  const binNpm = pkgOwnedPath(binReal);
  const kind = (npm: boolean) => (npm ? "包管理器全局安装" : "脚本安装");
  if (installNpm === binNpm) {
    return { name, status: "ok", detail: `一致（${kind(installNpm)}）：install=${install}；PATH dia=${binReal}` };
  }
  // 修复方向跟着「谁是预期安装」走；npm 方向给一条可直接复制的命令（不真的调 npm，确定性优先）
  const fix = `npm i -g @minonl/dia@latest && ln -sfn "$(npm prefix -g)/bin/dia" ${quoteArg(bin)}`;
  return {
    name,
    status: "warn", // 脚本安装已降级为「开发/离线通道」，遮蔽只提示不判红
    detail: `安装类型不一致：install=${install}（${kind(installNpm)}）但 PATH dia=${binReal}（${kind(binNpm)}）；修复：${fix}`,
  };
}

/** bootstrap：内置能力是否跟随当前包版本（升级 dia 后提示刷新，不需要用户手装）。 */
function bootstrapCheck(): Check {
  const stamp = defaultMsg.readStamp();
  const pkg = defaultMsg.pkgVersion();
  if (!stamp) return { name: "bootstrap", status: "warn", detail: "内置能力尚未装配（修复：dia postinstall；或安装时允许脚本 --allow-scripts=@minonl/dia）" };
  if (stamp.pkg !== pkg) {
    return { name: "bootstrap", status: "warn", detail: `内置能力可能过期：自举戳 pkg=${stamp.pkg}，当前 ${pkg}；修复：dia postinstall` };
  }
  return { name: "bootstrap", status: "ok", detail: `内置能力已装配（pkg=${pkg}，kit=${stamp.kit ?? "-"}）` };
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
  if (st.state === "missing") {
    // persona 装/切换后会自动建；这里只提示，不要求人手动跑（派生物原则）
    return { name, status: "warn", detail: `${root}（索引未建：首次检索或下次 persona 装/切换会自动建；也可运行 ${rebuild}）` };
  }
  const why = st.state === "foreign" ? `索引属于其它知识根（${st.db}）` : describeStale(st);
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

  // 渲染产物（宿主侧）只读比对：语义与 persona.verify 分工明确——
  //   verify 判「persona 内容完整性 / 归属」（真问题 → fail）；
  //   render 判「宿主侧产物是否被手改 / 丢失」（可被 `dia persona render` 修好 → warn，不改变退出码语义）。
  // 未安装 / 无 lock / 宿主不支持时降级为 skip（status ok + detail 前缀），不拉红。
  try {
    const rep = persona.renderDrift(sc.id);
    if (rep.skipped) {
      checks.push({ name: `${prefix}persona.render`, status: "ok", detail: `跳过：${rep.skipped}` });
    } else if (!rep.drift.length) {
      checks.push({ name: `${prefix}persona.render`, status: "ok", detail: `宿主产物与 ${rep.id}@${rep.version} 一致` });
    } else {
      const shown = rep.drift.slice(0, 3).map((d) => `${d.action}: ${d.path}`);
      const more = rep.drift.length > shown.length ? `（共 ${rep.drift.length} 处）` : "";
      checks.push({
        name: `${prefix}persona.render`,
        status: "warn",
        detail: `${shown.join("; ")}${more}；修复：dia persona render ${quoteArg(rep.id)}`,
      });
    }
  } catch (e: any) {
    checks.push({ name: `${prefix}persona.render`, status: "ok", detail: `跳过（${e?.message || String(e)}）` });
  }

  // kit 校验
  // 只校验该 persona 引用的 kit；未引用的“孤儿 kit”不拖红（它们不属于这个 persona）
  let refs: { id: string; version: string }[] = [];
  try { refs = JSON.parse(readFileSync(join(sc.dir, "dia.lock"), "utf8")).kits ?? []; } catch { refs = []; }
  if (!refs.length) checks.push({ name: `${prefix}kits`, status: "ok", detail: "无独立 kit（内容由 persona 自带）" });
  for (const k of refs) {
    try {
      const r = kit.verify(k.id, k.version);
      checks.push({ name: `${prefix}kit:${k.id}@${k.version}`, status: r.ok ? "ok" : "fail", detail: r.ok ? "一致" : r.drift.join("; ") });
    } catch (e: any) {
      checks.push({ name: `${prefix}kit:${k.id}@${k.version}`, status: "fail", detail: e?.message });
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

  const install = paths.installDir();
  checks.push({
    name: "paths",
    status: install === paths.diaHome() ? "warn" : "ok",
    detail: `install=${install} data=${paths.diaHome()}${install === paths.diaHome() ? "（安装物与数据同根）" : ""}`,
  });
  checks.push(installShadowCheck());
  checks.push(bootstrapCheck());

  const wt = join(install, "packages/wt/bin/dia-wt");
  checks.push({ name: "wt", status: existsSync(wt) ? "ok" : "warn", detail: existsSync(wt) ? wt : "dia wt 未安装（npm 包不完整？npm i -g @minonl/dia@latest 重装）" });

  checks.push(collabObserverCheck());

  const jobRoot = job.jobRootResolved();
  checks.push({
    name: "job",
    status: existsSync(jobRoot) ? "ok" : "warn",
    detail: `${jobRoot}${existsSync(jobRoot) ? "" : "（未创建；dia job install 首次运行会建）"}`,
  });

  const verdict = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { persona: ids.length === 1 ? ids[0] : null, personas: ids, checks, verdict };
}
