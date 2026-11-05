#!/usr/bin/env node
// docs-link-check.mjs —— 检查 docs/ 内链（GitHub Pages 视角）
//
// 规则：
//   · 只检查文档内的相对链接（http/mailto/# 跳过）
//   · 目标必须存在；且必须留在 docs/ 内（Pages 站点根是 /docs，指向仓库根的链接 404）
//   · `--remote` 额外请求线上 Pages 上的相对链接（需要站点已部署）
//
// 用法：node scripts/docs-link-check.mjs [--remote] [--base https://minonl.github.io/dia/]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const base = (args.find((a) => a.startsWith("--base=")) || "").split("=")[1] || "https://minonl.github.io/dia/";

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

const links = [];
for (const f of walk(DOCS)) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = m[1].trim().replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|tel:|#)/.test(raw)) continue;
    const [pathPart] = raw.split("#");
    if (!pathPart) continue;
    links.push({ file: relative(ROOT, f), raw, target: resolve(dirname(f), pathPart) });
  }
}

const errors = [];
for (const l of links) {
  const rel = relative(DOCS, l.target);
  if (rel.startsWith("..")) {
    errors.push(`${l.file}: ${l.raw} → 超出 docs/（Pages 站点根只有 /docs，会 404）`);
    continue;
  }
  if (!existsSync(l.target)) errors.push(`${l.file}: ${l.raw} → 目标不存在`);
}

if (remote) {
  for (const l of links) {
    const rel = relative(DOCS, l.target);
    if (rel.startsWith("..")) continue;
    const url = new URL(rel.split("\\").join("/"), base).toString();
    try {
      const r = await fetch(url, { method: "GET", redirect: "manual" });
      if (r.status >= 400) errors.push(`${l.file}: ${l.raw} → 线上 ${r.status} ${url}`);
    } catch (e) {
      errors.push(`${l.file}: ${l.raw} → 线上请求失败：${e}`);
    }
  }
}

if (errors.length) {
  console.error(`found ${errors.length} broken link(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`docs links ok (${links.length} relative link(s)${remote ? `, remote checked against ${base}` : ""})`);
