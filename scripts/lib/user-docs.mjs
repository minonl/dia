// user-docs.mjs —— 用户文档的**唯一事实源片段**（README 与 Pages 落地页共用）
//
// 原则：
//   · 能由代码决定的（包名/版本/engines/命令表/data 根）一律生成，不手写
//   · 不能由代码决定的（定位、限制、风险）留在 README 正文
//   · 命令表从 CLI 的 `usage:` 块解析；解析失败**必须报错**（fail closed），不允许静默少几条
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 从 packages/cli/src/index.ts 的 help() 文本里抽 usage 块。 */
export function readUsage(root) {
  const src = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
  const m = src.match(/usage:\n([\s\S]*?)`\);/);
  if (!m) throw new Error("E_DOCS: 找不到 help() 的 usage 块（packages/cli/src/index.ts）");
  return m[1].replace(/^\n+/, "").replace(/\s+$/, "");
}

/** usage 行 → 条目（续行并入上一条；`#` 后是说明）。 */
export function parseUsage(usage) {
  const items = [];
  let cur = null;
  for (const line of usage.split("\n")) {
    const m = /^ {2}dia (.+)$/.exec(line);
    if (m) {
      const body = m[1];
      const hash = body.indexOf("#");
      const synopsis = (hash === -1 ? body : body.slice(0, hash)).trim();
      const note = hash === -1 ? "" : body.slice(hash + 1).trim();
      cur = { noun: synopsis.split(/[\s|]/)[0], synopsis, note };
      items.push(cur);
    } else if (cur && /^ {4,}\S/.test(line)) {
      cur.synopsis = `${cur.synopsis} ${line.trim()}`; // 续行（如 ingest sessions 的长参数）
    }
  }
  if (!items.length) throw new Error("E_DOCS: usage 解析出 0 条命令（help 文本可能改了格式）");
  return items;
}

const MUST_HAVE = ["persona", "doctor", "update", "postinstall", "migrate", "kb", "kit", "collab", "wt"];
/** 生成前自检：关键命令必须在 help 里出现，否则说明 help 漏了（例如新增命令忘记写 usage）。 */
export function assertCoverage(items) {
  const nouns = new Set(items.map((i) => i.noun));
  const missing = MUST_HAVE.filter((n) => !nouns.has(n));
  if (missing.length) throw new Error(`E_DOCS: help 缺少命令：${missing.join(", ")}（先补 usage 再生成文档）`);
}

function table(items) {
  const rows = ["| 命令 | 用法 | 说明 |", "|---|---|---|"];
  for (const i of items) {
    rows.push(`| \`${i.noun}\` | \`dia ${i.synopsis}\` | ${i.note || ""} |`);
  }
  return rows.join("\n");
}

/**
 * 生成四个区块。linkMode: "repo"（README，相对链接）| "pages"（docs/index.md，GitHub 绝对链接）
 */
export function renderBlocks({ pkg, usage, linkMode = "repo", repo = "minonl/dia", branch = "main", headingLevel = 2 }) {
  const items = parseUsage(usage);
  assertCoverage(items);
  const blob = `https://github.com/${repo}/blob/${branch}`;

  const install = `${"#".repeat(headingLevel)} 安装

\`\`\`bash
# npm（推荐）。npm 12 起默认拦截全局包的安装脚本，需显式放行一次
npm i -g ${pkg.name} --allow-scripts=${pkg.name}

# bun / pnpm 全局装不会自动跑 postinstall —— 装完补一条
bun add -g ${pkg.name} && dia postinstall
pnpm add -g ${pkg.name} && dia postinstall

# 无论哪种方式，这一步都能让「内置能力」就位（幂等，可重复跑）
dia postinstall
dia version && dia doctor
\`\`\`

- 要求 Node ≥ ${pkg.engines.node.replace(/^>=/, "")}（kb/ingest 用 \`node:sqlite\`），或 Bun ≥ ${pkg.engines.bun.replace(/^>=/, "")}。
- 安装只写磁盘：数据根 \`~/.dia\` + 3 个宿主 skill 软链（\`~/.config/opencode/skill/dia-msg\`、\`~/.agents/skills/dia-msg\`、\`~/.dsh/skills/dia-msg\`）；**不动** \`default_agent\`、不启停服务。
- 用了 \`--ignore-scripts\` 或 npm 拦截了脚本 → 上面那条 \`dia postinstall\` 就是补初始化。
- \`dia doctor\` 退出码：\`0\` 全绿｜\`1\` 有 warn（干净机器上 persona/job 未装属正常）｜\`2\` 有 fail。确认内置能力就看 \`bootstrap\` 项。`;

  const quickstart = `${"#".repeat(headingLevel + 1)} 首次使用（最小可用）

\`\`\`bash
dia postinstall                    # 内置能力就位（幂等；安装时放行了脚本可跳过）
dia doctor                         # 看 bootstrap 是否为 ✓（有 warn 是正常的）
dia persona add <id> --from <git URL|本地目录> --dry-run   # 先看会写哪些文件
dia persona add <id> --from <git URL|本地目录>             # persona 是外部资产，必须显式装
dia persona default <id>           # 可选：设成宿主默认 agent
\`\`\`

- **persona 必须显式安装**（包里不带 persona）；内置能力不需要手动装。
- 没有 persona 时 \`dia kb\` 以当前目录为知识根 —— 指定 \`--root DIR\` 或先装 persona。

`;
  const update = `${"#".repeat(headingLevel)} 更新

\`\`\`bash
dia update --check     # 有新版 → exit 1
dia update             # npm 安装：自动 npm i -g，并在进程内补齐内置能力
\`\`\`

- 其它包管理器：\`bun add -g ${pkg.name}@latest\` / \`pnpm add -g ${pkg.name}@latest\`，然后 \`dia postinstall\`。
- \`dia update\` 只自动补内置 \`dia-msg\`；有新的内置能力时以 \`dia postinstall\` 收口（\`dia doctor\` 的 \`bootstrap\` 会提示）。`;

  const uninstall = `${"#".repeat(headingLevel)} 卸载

按顺序：**先让 dia 把自己的产物摘干净，再删 CLI 和数据**。

\`\`\`bash
# 1) persona 与默认 agent
dia persona default --show          # 若默认 agent 是 dia 装的 persona，先复位
dia persona default --unset
dia persona list                    # 逐个移除；手改过的产物会 skip，按提示手删
dia persona remove <id>

# 2) 内置能力（删 3 个 skill 软链 + ~/.dia/kits/dia-msg）
dia collab disable

# 3) CLI 本体（用当初安装它的那个包管理器）
npm uninstall -g ${pkg.name}        # bun remove -g / pnpm remove -g

# 4) 数据根（不可逆；先看一眼里面有什么）
ls ~/.dia && cp -a ~/.dia ~/dia-backup-$(date +%Y%m%d)
rm -rf ~/.dia
\`\`\`

- 数据根 \`~/.dia\` 里有 persona、kit、消息、审计、任务与索引；**删之前先备份**。
- 宿主渲染产物（不随上一步删除）：\`~/.config/opencode/agents/<id>.md\`、\`~/.dsh/profiles/<id>/\`、persona 声明的 \`~/.agents/skills/<name>\`。
- 旧机器残留可一并清理：\`~/.local/share/dia\`（已退役的脚本安装）、\`~/.local/state/dia\`、\`~/.cache/dia\`。`;

  const commands = `${"#".repeat(headingLevel)} 命令

\`dia --help\` 是完整清单（本节由它生成）。

${table(items)}

更多文档见 [\`docs/\`](${linkMode === "pages" ? `${blob}/docs` : "docs"})${linkMode === "pages" ? "" : "。"}`;

  return { install, quickstart, update, uninstall, commands, items };
}
