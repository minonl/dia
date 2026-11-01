// dsh.ts — 宿主 dsh 的「配置自检」：把 dsh 自己能发现的问题，提前到 dia doctor。
//
// 背景（2026-11-01）：dabo 的 preset 插入 tool-fs-search 时漏了必填 config，
// dsh 只在**启动日志**里 warn（agent preset dabo: … invalid config），startup 仍成功 →
// 用户看不到，agent 静默降级。dia 不认识 dsh 插件 schema，但可以借 dsh 自己的
// `--dump-config` + 插件导出的 `Config` 做交叉校验。
//
// 边界：只在「dsh 存在 + 本 persona 渲染过 dsh profile」时跑；拿不到就跳过，不误报。
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PresetCheck {
  ok: boolean;
  /** 跳过原因（dsh 不可用 / 没有 dsh profile）。 */
  skipped?: string;
  issues: string[];
}

const dshBin = () => process.env.DIA_DSH_BIN || "dsh";

/** PATH 里找命令（不执行 shell，避免注入）。 */
function which(cmd: string): string | null {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

const dshRoot = () => {
  if (process.env.DIA_DSH_ROOT) return process.env.DIA_DSH_ROOT;
  const p = dshBin();
  const path = p.includes("/") ? p : which(p);
  if (!path) return null;
  try {
    const real = realpathSync(path);
    // <root>/lib/bin.js 或 <root>/bin/dsh.js → <root>
    return dirname(dirname(real));
  } catch { return null; }
};

/** 插件 id → npm 包（dsh 的命名约定：@deepseek-ai/dsh-<id>）。 */
const packageFor = (id: string) => `@deepseek-ai/dsh-${id}`;

/** 该插件是否「必须有 config」：调用它导出的 Config({})，失败即必填。 */
function requireConfig(root: string, id: string): { required: boolean; message?: string } {
  const pkg = packageFor(id);
  const dir = join(root, "node_modules", ...pkg.split("/"), "lib", "index.js");
  if (!existsSync(dir)) return { required: false };
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(process.env.DIA_PLUGIN);` +
      `if (!m.Config) { console.log("NO_CONFIG_EXPORT"); process.exit(0); }` +
      `try { m.Config({}); console.log("OPTIONAL"); } catch (e) { console.log("REQUIRED " + String(e.message).split("\\n")[0]); }`,
    ], { encoding: "utf8", timeout: 20000, env: { ...process.env, DIA_PLUGIN: dir } }).trim();
    if (out.startsWith("REQUIRED")) return { required: true, message: out.slice("REQUIRED ".length) };
    return { required: false };
  } catch {
    return { required: false }; // 导入失败不等于配置错误：宁可漏报不误报
  }
}

/** 从 `dsh --profile <id> --dump-config` 里取出 preset 块中「没写 config」的插件 id。 */
export function pluginsWithoutConfig(dump: string, personaId: string): string[] {
  const lines = dump.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- id: preset-${personaId}` && /^\s*- /.test(l) && l.indexOf("- id:") === 0);
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id: /.test(lines[i])) { end = i; break; } // 下一个顶层条目
  }
  const block = lines.slice(start, end);
  const ids: { id: string; index: number }[] = [];
  block.forEach((l, i) => {
    const m = /^\s{6}- id: (\S+)\s*$/.exec(l);
    if (m) ids.push({ id: m[1], index: i });
  });
  const missing: string[] = [];
  ids.forEach(({ id, index }, n) => {
    const until = n + 1 < ids.length ? ids[n + 1].index : block.length;
    const hasConfig = block.slice(index, until).some((l) => /^\s{8}config:/.test(l));
    if (!hasConfig) missing.push(id);
  });
  return missing;
}

export function checkPreset(personaId: string, profileDir: string): PresetCheck {
  if (!existsSync(profileDir)) return { ok: true, skipped: "未渲染 dsh profile", issues: [] };
  let dump: string;
  try {
    dump = execFileSync(dshBin(), ["--profile", personaId, "--dump-config"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000,
    });
  } catch {
    return { ok: true, skipped: "dsh 不可用（跳过 preset 自检）", issues: [] };
  }
  const missing = pluginsWithoutConfig(dump, personaId);
  if (!missing.length) return { ok: true, issues: [] };
  const root = dshRoot();
  if (!root) return { ok: true, skipped: "找不到 dsh 安装目录（跳过 schema 校验）", issues: [] };

  const issues: string[] = [];
  for (const id of missing) {
    const r = requireConfig(root, id);
    if (r.required) issues.push(`preset-${personaId}: ${id} 缺必填 config（${r.message ?? "required"}）`);
  }
  return { ok: issues.length === 0, issues };
}
