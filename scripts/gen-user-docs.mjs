#!/usr/bin/env node
// gen-user-docs.mjs —— 用代码事实刷新 README 的生成区块（安装/更新/卸载/命令）
//
// 用法：
//   node scripts/gen-user-docs.mjs           # 写入
//   node scripts/gen-user-docs.mjs --check   # 只校验（CI 用，exit 1 = 需要重新生成）
//
// 注意：只改 `<!-- gen:<name>:start -->…<!-- gen:<name>:end -->` 之间的内容，其余一字不动；
// 标记缺失直接报错（不猜位置）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readUsage, renderBlocks } from "./lib/user-docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const blocks = renderBlocks({ pkg, usage: readUsage(ROOT), linkMode: "repo" });

const src = readFileSync(README, "utf8");
let out = src;
for (const name of ["install", "quickstart", "update", "uninstall", "commands"]) {
  const re = new RegExp(`(<!-- gen:${name}:start -->)([\\s\\S]*?)(<!-- gen:${name}:end -->)`);
  if (!re.test(out)) throw new Error(`E_DOCS: README 缺少标记 gen:${name}:start/end`);
  out = out.replace(re, `$1\n${blocks[name].trimEnd()}\n$3`);
}

if (process.argv.includes("--check")) {
  if (out !== src) {
    console.error("E_DOCS: README 生成区块与代码不同步（跑 `bun run docs:gen`）");
    process.exit(1);
  }
  console.log("docs ok (README)");
  process.exit(0);
}
writeFileSync(README, out);
console.log("docs ok (README)");
