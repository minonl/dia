// default-msg —— dia 默认能力包（msg）的开关与装配
//
// 设计：docs/msg-collab-m0-design.md §5.0
// 边界：kit/skill 是 dia 框架资产；persona 只引用，不承载实现。
// 默认开启：capabilities.msg 缺省 = true；用户可 `dia collab disable` 或 DIA_MSG=0 关闭。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as kit from "./kit.ts";
import * as paths from "./paths.ts";

export interface MsgConfig {
  schema: 1;
  enabled: boolean;
  disabled_personas: string[];
  updated_at?: string;
}

export interface MsgStatus {
  enabled: boolean;
  reason?: string;
  kit_dir: string;
  kit_installed: string | null;
  config_file: string;
  disabled_personas: string[];
}

const configFile = () => join(paths.diaHome(), "collab", "config.json");
const builtinKitDir = () => join(paths.installDir(), "kits", "dia-msg");

export function readConfig(): MsgConfig {
  try {
    const c = JSON.parse(readFileSync(configFile(), "utf8")) as MsgConfig;
    return {
      schema: 1,
      enabled: c.enabled !== false,
      disabled_personas: Array.isArray(c.disabled_personas) ? c.disabled_personas : [],
      updated_at: c.updated_at,
    };
  } catch {
    return { schema: 1, enabled: true, disabled_personas: [] };
  }
}

function writeConfig(c: MsgConfig): MsgConfig {
  const next = { ...c, schema: 1 as const, updated_at: new Date().toISOString() };
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

/** 关闭：全局 enabled=false，或把 persona 加入 disabled_personas。 */
export function setEnabled(enabled: boolean, personaId?: string): MsgConfig {
  const c = readConfig();
  if (personaId) {
    const set = new Set(c.disabled_personas);
    if (enabled) set.delete(personaId); else set.add(personaId);
    return writeConfig({ ...c, disabled_personas: [...set].sort() });
  }
  return writeConfig({ ...c, enabled });
}

export function isEnabled(personaId?: string): { enabled: boolean; reason?: string } {
  if (process.env.DIA_MSG === "0" || process.env.DIA_MSG === "false") return { enabled: false, reason: "env:DIA_MSG" };
  const c = readConfig();
  if (!c.enabled) return { enabled: false, reason: "config:global-disabled" };
  if (personaId && c.disabled_personas.includes(personaId)) return { enabled: false, reason: `config:persona-disabled:${personaId}` };
  return { enabled: true };
}

function installedVersion(): string | null {
  const dir = join(paths.diaHome(), "kits", "dia-msg");
  if (!existsSync(dir)) return null;
  try {
    const rows = readdirSync(dir).filter((v) => statSync(join(dir, v)).isDirectory()).sort();
    return rows.length ? rows[rows.length - 1] : null;
  } catch { return null; }
}

/** 自动装配只在「真实用户数据根」上做，避免测试/CI 的临时 DIA_ROOT 把 skill 写到真实 HOME。
 *  DIA_MSG_AUTO=1 强制开，=0 强制关。 */
function autoInstallAllowed(): boolean {
  if (process.env.DIA_MSG_AUTO === "1") return true;
  if (process.env.DIA_MSG_AUTO === "0") return false;
  return resolve(paths.diaHome()) === resolve(join(homedir(), ".dia"));
}

/** 装配默认 kit；失败不阻断 persona 安装，返回 reason 供 CLI/doctor 显示。 */
/** 包版本（installDir/package.json）；取不到返回 "unknown"。 */
export function pkgVersion(): string {
  try { return String(JSON.parse(readFileSync(join(paths.installDir(), "package.json"), "utf8")).version || "unknown"); }
  catch { return "unknown"; }
}

const stampFile = () => join(paths.stateDir(), "bootstrap.json");

/** 自举戳：包版本 + 内置 kit 版本（升级 dia 后能看出「包内的内置能力是否需要刷新」）。 */
export function readStamp(): { pkg?: string; kit?: string; at?: string } | null {
  try { return JSON.parse(readFileSync(stampFile(), "utf8")); } catch { return null; }
}

function writeStamp(kitId?: string) {
  try {
    mkdirSync(paths.stateDir(), { recursive: true });
    writeFileSync(stampFile(), JSON.stringify({ pkg: pkgVersion(), kit: kitId ?? null, at: new Date().toISOString() }, null, 1));
  } catch { /* 自举戳写不了不影响功能 */ }
}

export function ensure(personaId?: string, opts: { force?: boolean } = {}): { ok: boolean; reason?: string; kit?: string } {
  const gate = isEnabled(personaId);
  if (!gate.enabled && !opts.force) return { ok: false, reason: gate.reason };
  if (!opts.force && !autoInstallAllowed()) return { ok: false, reason: "auto-install-skipped:non-default-root（dia collab enable 可强制安装）" };
  const source = builtinKitDir();
  if (!existsSync(join(source, "dia.json"))) return { ok: false, reason: `missing-kit:${source}` };
  try {
    const r = kit.install(source, { force: true });
    writeStamp(r.id);
    return { ok: true, kit: `${r.id}@${r.version}` };
  } catch (e: any) {
    return { ok: false, reason: `kit-install:${e?.message || String(e)}` };
  }
}

export function status(personaId?: string): MsgStatus {
  const gate = isEnabled(personaId);
  const c = readConfig();
  return {
    enabled: gate.enabled,
    reason: gate.reason,
    kit_dir: builtinKitDir(),
    kit_installed: installedVersion(),
    config_file: configFile(),
    disabled_personas: c.disabled_personas,
  };
}

/** 供 persona 渲染时判断：manifest.capabilities.msg === false 视为显式关闭。 */
export function manifestDisabled(capabilities?: Record<string, unknown>): boolean {
  return capabilities?.msg === false;
}

/** persona 安装/渲染时调用：manifest 显式关闭优先，其次看全局/按 persona 配置。 */
export function ensureForPersona(id: string, capabilities?: Record<string, unknown>): { ok: boolean; reason?: string; kit?: string } {
  if (manifestDisabled(capabilities)) return { ok: false, reason: "manifest:capabilities.msg=false" };
  return ensure(id);
}

/** 展开 ~ 只用于展示/检查，不写文件。 */
export function expandHome(p: string): string {
  const home = process.env.DIA_HOME || homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}
