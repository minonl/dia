// scope.ts — persona 作用域：命令怎么知道自己属于哪个 agent
//
// 解析优先级：显式 --persona > DIA_PERSONA > 唯一已装 persona（>1 个时必须显式指定，不猜）。
// 作用域回答三件事：读哪棵知识树、用哪个数据根、有哪些域命令可委派。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as active from "./active.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as paths from "./paths.ts";

// 目录在调用时解析（同 kit.ts：模块加载时固化会污染跨测试/多 persona 场景）
const dataDir = () => paths.diaHome();
const homeDir = () => process.env.DIA_HOME || homedir();

export interface KitScope {
  id: string;
  version: string;
  dir: string;
  root: string;
  knowledge: string[];
  commands: { name: string; entry: string; runtime?: "bun" | "node"; env?: Record<string, string> }[];
  dataRoot?: string;
  env?: { files: string[]; keys: string[] };
}

export interface Scope {
  id: string;
  version: string;
  dir: string;
  kits: KitScope[];
  knowledgeRoot?: string;
  dataRoot?: string;
  env?: { files: string[]; keys: string[] };
}

const expand = (p: string) => { const h = homeDir(); return p === "~" ? h : p.startsWith("~/") ? join(h, p.slice(2)) : p; };
const latest = (dir: string) => readdirSync(dir).filter((v) => statSync(join(dir, v)).isDirectory()).sort().pop();

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * 旧 lock 的兜底：早期 `persona add` 不写 `content` 段，导致作用域只剩 persona 身份、没有知识根/域命令。
 * 这里只读安装目录里自带的 `dia.json` 补齐，**不回写 lock**（安装态由 add/update 负责）。
 */
function contentFromInstalled(dir: string): { knowledge: string[]; commands: any[]; dataRoot: string | null; env: any } {
  const m = readJson(join(dir, "dia.json")) ?? {};
  return { knowledge: m.knowledge ?? [], commands: m.commands ?? [], dataRoot: m.data_root ?? null, env: m.env ?? null };
}

function loadKit(id: string, version: string): KitScope | null {
  const dir = join(dataDir(), "kits", id, version);
  const lock = readJson(join(dir, "kit.lock"));
  if (!lock) return null;
  const root = resolve(dir, lock.root ?? ".");
  return {
    id, version, dir, root,
    knowledge: (lock.knowledge ?? []).map((k: string) => resolve(root, k)),
    commands: lock.commands ?? [],
    dataRoot: lock.dataRoot ? expand(lock.dataRoot) : undefined,
  };
}

export function installedPersonas(): string[] {
  const p = join(dataDir(), "personas");
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

export function current(explicit?: string): Scope | null {
  const want = explicit || process.env.DIA_PERSONA;
  let id = want;
  if (!id) {
    const all = installedPersonas();
    if (all.length > 1) throw new Error(`E_SCOPE: multiple personas installed (${all.join(", ")}); pass --persona`);
    id = all[0];
  }
  if (!id) return null;
  const idDir = join(dataDir(), "personas", id);
  if (!existsSync(idDir)) throw new Error(`E_SCOPE: persona not installed: ${id}`);
  const version = active.effective(id)?.version ?? latest(idDir)!;
  const dir = join(idDir, version);
  const lock = readJson(join(dir, "dia.lock")) ?? {};
  const kits: KitScope[] = [];
  // persona 自带内容优先（它就在 persona 树里，路径即 lock 所在目录）；旧 lock 缺 content 时用 dia.json 兜底
  const c = lock.content ?? contentFromInstalled(dir);
  if ((c.knowledge ?? []).length || (c.commands ?? []).length) {
    kits.push({
      id, version, dir, root: dir,
      knowledge: (c.knowledge ?? []).map((k: string) => resolve(dir, k)),
      commands: c.commands ?? [],
      dataRoot: c.dataRoot ? expand(c.dataRoot) : undefined,
      env: c.env ? { files: (c.env.files ?? []).map(expand), keys: c.env.keys ?? [] } : undefined,
    });
  }
  for (const k of lock.kits ?? []) {
    const ks = loadKit(k.id, k.version);
    if (ks) kits.push(ks);
  }
  const knowledge = kits.flatMap((k) => k.knowledge);
  return {
    id, version, dir, kits,
    knowledgeRoot: knowledge[0],
    dataRoot: kits.find((k) => k.dataRoot)?.dataRoot,
    env: kits.find((k) => k.env)?.env,
  };
}

/** 环境注入：把 persona 作用域翻译成子进程可见的变量。 */
export function scopeEnv(s: Scope, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { DIA_PERSONA: s.id, DIA_KITS: s.kits.map((k) => `${k.id}@${k.version}`).join(",") };
  // DIA_DATA_ROOT_SCOPE 是通用口径；YAN_DATA_ROOT 保留给既有 yan 配方（勿在新 persona 里依赖）
  if (s.dataRoot) { env.DIA_DATA_ROOT_SCOPE = s.dataRoot; env.DIA_DATA_ROOT = s.dataRoot; env.YAN_DATA_ROOT = s.dataRoot; }
  if (s.knowledgeRoot) env.DIA_KB_ROOT = s.knowledgeRoot;
  for (const [k, v] of Object.entries(extra)) env[k] = expand(v);
  return env;
}
