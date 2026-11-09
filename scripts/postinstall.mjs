#!/usr/bin/env node
// npm/bun 全局安装后的一次性自举：装配内置能力（dia-msg）+ 写自举戳。
// 原则：只在「全局安装」且非 CI 时跑；永不失败（装不上不影响 npm install，`dia doctor` 会提示）。
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const globalInstall = process.env.npm_config_global === "true" || process.env.npm_config_global === "1";
const skip = process.env.DIA_NO_POSTINSTALL === "1" || Boolean(process.env.CI) || !globalInstall;
if (skip) process.exit(0);

const bin = join(root, "bin", "dia.js");
if (!existsSync(bin)) process.exit(0);
spawnSync(process.execPath, [bin, "postinstall", "--quiet"], { stdio: "inherit" });
process.exit(0); // 自举失败不阻断安装
