// dia msg dsh —— 把 dsh 版 dia-inbox 插件装进某个 profile
//
// 为什么需要安装器：dsh 的插件是「pnpm 包 + cordis.patch.yml 里一行 insert」，
// 手改 profile 容易写坏（YAML/缩进/包名）。这里做三件事并留 dry-run：
//   1) 复制插件包到 <profile>/plugins/dia-inbox
//   2) `dsh plugin --profile <p> add file:plugins/dia-inbox`
//   3) 在 cordis.patch.yml 追加一段 insert（已存在则跳过），最后用 --dump-config 验证
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as paths from "./paths.ts";

export const PLUGIN_ID = "dia-inbox";
export const PLUGIN_PKG = "@dia/dsh-inbox";

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function pluginSource(): string {
  return join(paths.installDir(), "kits", "dia-msg", "dsh", "dia-inbox");
}

export const MANAGED_BEGIN = "# >>> dia-managed:dia-inbox";
export const MANAGED_END = "# <<< dia-managed:dia-inbox";

export function patchSnippet(): string {
  return `${MANAGED_BEGIN}\n- insert:\n    - id: ${PLUGIN_ID}\n      name: '${PLUGIN_PKG}'\n${MANAGED_END}\n`;
}

/** 幂等追加：已包含 `id: dia-inbox` 就原样返回。 */
export function applyPatch(yaml: string): string {
  if (yaml.includes(MANAGED_BEGIN)) return yaml;
  // 空 patch 层（shipped profile 的默认 `[]`，可能重复出现）：整体替换为 insert；
  // 直接追加会变成「两个顶层节点」→ YAML 解析失败（实测 headless）
  const meaningful = yaml.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (meaningful.length === 0 || meaningful.every((l) => l === "[]")) {
    const comments = yaml.split("\n").filter((l) => l.trim().startsWith("#")).join("\n");
    return `${comments ? comments + "\n" : ""}${patchSnippet()}`;
  }
  const sep = yaml.endsWith("\n") ? "" : "\n";
  return `${yaml}${sep}\n${patchSnippet()}`;
}

export interface DshInstallResult {
  profile: string;
  profileDir: string;
  pluginDir: string;
  patchFile: string;
  snippet: string;
  applied: boolean;
  steps: string[];
  error?: string;
}

export function install(opts: { profile?: string; dryRun?: boolean } = {}): DshInstallResult {
  const profile = opts.profile || "";
  const profileDir = join(dshHome(), "profiles", profile);
  const pluginDir = join(profileDir, "plugins", PLUGIN_ID);
  const patchFile = join(profileDir, "cordis.patch.yml");
  const base: DshInstallResult = { profile, profileDir, pluginDir, patchFile, snippet: patchSnippet(), applied: false, steps: [] };
  if (!profile) return { ...base, error: "E_USAGE: 需要 --profile <name>（不会默认改某个 profile）" };
  if (!existsSync(profileDir)) return { ...base, error: `E_NOT_FOUND: ${profileDir}` };
  const src = pluginSource();
  if (!existsSync(join(src, "index.js"))) return { ...base, error: `E_SOURCE: 插件源不存在：${src}（npm 包缺 kits/？）` };

  if (opts.dryRun) {
    return { ...base, steps: ["复制插件到 " + pluginDir, `dsh plugin --profile ${profile} add file:plugins/${PLUGIN_ID}`, "追加 cordis.patch.yml insert", "dsh --dump-config 校验"] };
  }

  try {
    mkdirSync(join(profileDir, "plugins"), { recursive: true });
    cpSync(src, pluginDir, { recursive: true, force: true });
    base.steps.push("plugin-copied");

    const add = spawnSync("dsh", ["plugin", "--profile", profile, "add", `file:plugins/${PLUGIN_ID}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (add.status !== 0) return { ...base, error: `E_PNPM: ${(add.stderr || add.stdout || "").trim().split("\n")[0] || `exit ${add.status}`}` };
    base.steps.push("pnpm-added");

    const yaml = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
    const next = applyPatch(yaml);
    if (next !== yaml) {
      writeFileSync(`${patchFile}.bak-${Date.now()}`, yaml);
      writeFileSync(patchFile, next);
      base.steps.push("patch-appended");
    } else {
      base.steps.push("patch-present");
    }

    const dump = spawnSync("dsh", ["--profile", profile, "--dump-config"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (dump.status !== 0) return { ...base, error: `E_DUMP: ${(dump.stderr || "").trim().split("\n")[0] || `exit ${dump.status}`}` };
    base.steps.push("validated");
    return { ...base, applied: true };
  } catch (e: any) {
    return { ...base, error: e?.message || String(e) };
  }
}
