#!/usr/bin/env node
// docs-index.mjs —— 生成 docs 菜单 + agent 可读索引（单一来源 = docs/**.md 本身）
//
// 产出（都在仓库根，除 docs/index.md）：
//   docs/index.md   人读菜单（GitHub Pages 不可用时也能当导航；开 Pages 后直接可用）
//   llms.txt        agent 入口（llms.txt 约定：标题 + 一句话 + 链接）
//   llms-full.txt   全量拼接（agent 一次性读取；体积大，**不入库**，本地生成）
//
// 用法：
//   node scripts/docs-index.mjs          # 生成
//   node scripts/docs-index.mjs --check  # 只校验是否最新（CI 用，exit 1 = 需要重新生成）
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { readUsage, renderBlocks } from "./lib/user-docs.mjs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const REPO = process.env.DOCS_REPO || "minonl/dia";
const BRANCH = process.env.DOCS_BRANCH || "main";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const SKIP = new Set(["index.md", "deps.jsonl", "deps.yaml"]);
const CATEGORY_ORDER = ["现状", "安装与配置", "平台与宿主", "团队与自动化", "安全与审计", "理论", "迁移", "留痕", "归档", "其他"];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

function extract(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const title = (lines.find((l) => l.startsWith("# ")) || "").slice(2).trim() || relative(DOCS, file);
  const clean = (l) => l.replace(/^>\s?/, "").replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  const quotes = [];
  let plain = "";
  let inCode = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith("```")) { inCode = !inCode; continue; }
    if (inCode || !l) continue;
    if (l.startsWith("#") || l.startsWith("|") || l.startsWith("- ") || l.startsWith("* ") || l.startsWith("<")) continue;
    if (l.startsWith(">")) { if (!plain && quotes.length < 3) quotes.push(clean(l)); continue; }
    if (!plain) plain = clean(l);
  }
  // 去掉开场「日期 2026-xx-xx。」，取第一条有信息量的句子
  const strip = (x) => x.replace(/^(日期|更新)[^。]*。\s*/, "").trim();
  const summary = [...quotes.map(strip), strip(plain)].find((x) => x.length >= 8) || "(无摘要)";
  return { title, summary, text };
}

function categoryOf(rel) {
  const p = rel.split("/");
  if (p.length === 1) return "现状";
  const d = p[0];
  if (d === "migrations") return "迁移";
  if (d === "platforms") return "平台与宿主";
  if (d === "security") return "安全与审计";
  if (d === "history") return "归档";
  if (d === "research" || d === "review") return "留痕";
  return "其他";
}

function build() {
  const files = walk(DOCS).filter((f) => {
    const rel = relative(DOCS, f);
    return !SKIP.has(rel) && !rel.split("/").some((x) => x.startsWith("."));
  });
  const entries = files.map((f) => ({ rel: relative(DOCS, f), ...extract(f), file: f }));

  // docs/index.md
  const groups = new Map();
  for (const e of entries) {
    const c = categoryOf(e.rel);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(e);
  }
  const order = [...CATEGORY_ORDER.filter((c) => groups.has(c)), ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c))];
  const b = renderBlocks({ pkg, usage: readUsage(ROOT), linkMode: "pages", repo: REPO, branch: BRANCH, headingLevel: 3 });
  const repoBase = `https://github.com/${REPO}/blob/${BRANCH}`;
  let md = `# dia（嗲）\n\n> 轻量 agent 框架：预设注入 + 知识索引 + 审计/止血 + 会话采集。\n> 控制面是确定性 CLI，agent 面在独立 persona。\n\n`;
  md += `> 本页由 \`scripts/docs-index.mjs\` 生成（\`bun run docs:gen\`），**不要手改**。\n\n`;
  md += `${b.install}\n\n${b.quickstart}\n\n${b.update}\n\n${b.uninstall}\n\n${b.commands}\n\n`;
  md += `## 文档菜单\n\n`;
  md += `Agent 入口：[\`llms.txt\`](${repoBase}/llms.txt)（全量 \`llms-full.txt\` 本地生成，**不入库**：\`bun run docs:gen\`）\n\n`;
  for (const c of order) {
    md += `## ${c}\n\n| 文档 | 一句话 |\n|---|---|\n`;
    for (const e of groups.get(c).sort((a, b) => a.rel.localeCompare(b.rel))) {
      md += `| [${e.title}](${e.rel}) | ${e.summary.replace(/\|/g, "\\|")} |\n`;
    }
    md += "\n";
  }

  // llms.txt
  const base = `https://github.com/${REPO}/blob/${BRANCH}/docs/`;
  let llms = `# dia\n\n> dia（嗲）：superagent / agent-team 的生成与维护工具；控制面是确定性 CLI，agent 面在独立 persona（dia-evoler）。\n\n`;
  llms += `## 说明\n\n- 文档单一来源：仓库 \`docs/**.md\`；本文件由 \`scripts/docs-index.mjs\` 生成。\n`;
  llms += `- 全量内容（无摘要）：本地运行 \`bun run docs:index\` 生成 \`llms-full.txt\`（**不入库**，避免生成物重复与泄漏面）\n\n## Docs\n\n`;
  for (const c of order) {
    llms += `### ${c}\n\n`;
    for (const e of groups.get(c).sort((a, b) => a.rel.localeCompare(b.rel))) {
      llms += `- [${e.title}](${base}${e.rel}): ${e.summary}\n`;
    }
    llms += "\n";
  }

  // llms-full.txt
  let full = `# dia — full docs\n\n> 生成物；来源 docs/**.md。仓库：https://github.com/${REPO}\n\n`;
  for (const e of entries.sort((a, b) => a.rel.localeCompare(b.rel))) {
    full += `\n\n---\n\n<!-- ${e.rel} -->\n\n${e.text.trim()}\n`;
  }

  return {
    "docs/index.md": md,
    "llms.txt": llms,
    "llms-full.txt": full,
  };
}

const outputs = build();
const check = process.argv.includes("--check");
// llms-full.txt 是本地生成物（不入库）：--check 只校验入库的 docs/index.md 与 llms.txt。
const CHECKED = new Set(["docs/index.md", "llms.txt"]);
let drift = 0;
for (const [rel, content] of Object.entries(outputs)) {
  if (check && !CHECKED.has(rel)) continue;
  const p = join(ROOT, rel);
  const old = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (old === content) continue;
  drift++;
  if (check) console.error(`out of date: ${rel}`);
  else { writeFileSync(p, content); console.log(`wrote ${rel} (${content.length} bytes)`); }
}
if (check) {
  if (drift) { console.error("run `bun run docs:index` to regenerate"); process.exit(1); }
  console.log("docs index up to date");
}
