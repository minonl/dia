// dia 唯一路径解析器（single resolver）
//
// 规则（2026-11-05 用户拍板）：
//   · 数据根 = `~/.dia`（跨平台同一路径），`DIA_HOME` 仅作逃生口
//   · 旧名 `DIA_DATA_DIR` 保留一个 release 作兼容；新代码一律用 diaHome()
//   · msg/agents/state/cache/job 全部从数据根派生；**不读** DIA_MSG_ROOT / DIA_AGENTS_ROOT
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 数据根：DIA_ROOT（新）> DIA_DATA_DIR（兼容，一个 release 后删）> ~/.dia
 *  ⚠️ 不用 DIA_HOME：现有语义是「展开 ~ 用的家目录」（scope.ts），与本根无关。 */
export function diaHome(): string {
  const h = process.env.DIA_ROOT || process.env.DIA_DATA_DIR;
  return h && h.length ? h : join(homedir(), ".dia");
}

export const personasDir = () => join(diaHome(), "personas");
export const msgRoot = () => join(diaHome(), "msg");
export const agentsRoot = () => join(diaHome(), "agents");
export const stateDir = () => process.env.DIA_STATE_DIR || join(diaHome(), "state"); // DIA_STATE_DIR: 兼容旧值（deprecated）
export const cacheRoot = () => join(diaHome(), "cache");
export const backupsDir = () => join(diaHome(), "backups");
export const jobRoot = () => join(diaHome(), "job");
export const ingestDir = () => join(diaHome(), "ingest");
export const runsDir = () => join(diaHome(), "runs");

/** 安装目录（CLI/dist/packages）；安装器可用 DIA_HOME_INSTALL 覆盖
 *  校验存在性：env 指向已删除目录时不再静默失败（会表现为 missing-kit 谜之错误），而是告警并回退探测。 */
export function installDir(): string {
  const env = process.env.DIA_INSTALL_DIR || process.env.DIA_HOME_INSTALL;
  if (env) {
    if (existsSync(env)) return env;
    process.stderr.write(`! warn: DIA_INSTALL_DIR=${env} 不存在，忽略该覆盖并自动探测安装目录\n`);
  }
  try {
    const derived = dirname(dirname(fileURLToPath(import.meta.url)));
    if (existsSync(derived)) return derived;
  } catch { /* 编译单文件/无文件系统包装：落到下面 */ }
  return diaHome();
}
/** 源码缓存（克隆/检出）；兼容旧 DIA_CACHE_DIR */
export const srcCacheDir = () => process.env.DIA_CACHE_DIR || join(cacheRoot(), "src");
