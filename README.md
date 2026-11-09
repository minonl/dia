# dia（嗲）

轻量 agent 框架：**预设注入 + 知识索引 + 审计/止血 + 会话采集**。

> **现状先看 [`docs/overview.md`](docs/overview.md)**：dia / yan / dabo 三方对照、能力面、已知缺口、文档地图。
> 长期定位看 [`docs/vision.md`](docs/vision.md)：superagent / agent-team 工厂、平台版本经验库、fleet 边界。

## 文档入口（人 / agent）

- 人：菜单 [`docs/index.md`](docs/index.md)（由脚本生成，开 GitHub Pages 可直接当站点）
- agent：[`llms.txt`](llms.txt)（摘要 + 链接）；全量 `llms-full.txt` 本地运行 `bun run docs:gen` 生成（不入库）
- 生成/校验：`bun run docs:gen` / `bun run docs:check`（安装/更新/卸载/命令表由代码生成，CI 跑 check 防漂移）

> 定位：dabo-agent（个人域）与 yan-agent（工作域）共用的底层能力。
> 设计见 [`docs/architecture.md`](docs/architecture.md)，现状见 [`docs/overview.md`](docs/overview.md)。

## 三层

```
dia（本仓库）        通用能力：知识索引 / 审计 / 采集 / 调度 / 包管理；不存业务数据
  ↑                    ↑
yan-agent（工作域）   dabo-agent（个人域）   各自的 preset + 知识 + 工具 + 策略
  ↓                    ↓
packages             知识包 / 技能包 / 工具包（默认无执行权）
```

## 语言选择（实测，2026-10-27，macOS M1）

| 指标 | Python 3.15 | Node 24 | Bun 1.4 |
|---|---|---|---|
| CLI 启动（10 次） | 0.43s | 0.47s | **0.09s** |
| 9.5MB zstd + 8975 行 JSON | 3.76s（stdlib zstd） | 0.33s | **0.32s** |
| 103 篇 md 建 FTS5 索引 | **0.27s** | 0.44s | 0.46s |
| FTS5 / zstd 内置 | ✅ | ✅ | ✅ |

结论：**TS 实现，Bun 优先开发，Node ≥24 兼容发布**。
原因不是性能，是分发（npm 公开包）与生态（opencode/dsh 同为 TS/Node）。
Python 原型已完成使命（行为对齐后删除）；其基线数字保留在下方「基线」。

> 注：opencode 自带运行时（可在无 Node 的机器上跑），dsh 依赖 Node。
> 因此 npm 包声明 `engines.node >= 24`；无 Node 的机器后续用 `bun build --compile` 的单文件二进制。

## Public release

已公开（2026-11-05）。发布门禁与检查项见 [`docs/security/public-release.md`](docs/security/public-release.md)：
树脱敏、Git 历史清洁、GitHub 元数据、独立审核 `pass`。改 visibility 前仍需过同一门禁。

<!-- gen:install:start -->
## 安装

```bash
# npm（推荐）。npm 12 起默认拦截全局包的安装脚本，需显式放行一次
npm i -g @minonl/dia --allow-scripts=@minonl/dia

# bun / pnpm 全局装不会自动跑 postinstall —— 装完补一条
bun add -g @minonl/dia && dia postinstall
pnpm add -g @minonl/dia && dia postinstall

# 无论哪种方式，这一步都能让「内置能力」就位（幂等，可重复跑）
dia postinstall
dia version && dia doctor
```

- 要求 Node ≥ 24（kb/ingest 用 `node:sqlite`），或 Bun ≥ 1.2。
- 安装只写磁盘：数据根 `~/.dia` + 3 个宿主 skill 软链（`~/.config/opencode/skill/dia-msg`、`~/.agents/skills/dia-msg`、`~/.dsh/skills/dia-msg`）；**不动** `default_agent`、不启停服务。
- 用了 `--ignore-scripts` 或 npm 拦截了脚本 → 上面那条 `dia postinstall` 就是补初始化。
- `dia doctor` 退出码：`0` 全绿｜`1` 有 warn（干净机器上 persona/job 未装属正常）｜`2` 有 fail。确认内置能力就看 `bootstrap` 项。
<!-- gen:install:end -->

<!-- gen:quickstart:start -->
### 首次使用（最小可用）

```bash
dia postinstall                    # 内置能力就位（幂等；安装时放行了脚本可跳过）
dia doctor                         # 看 bootstrap 是否为 ✓（有 warn 是正常的）
dia persona add <id> --from <git URL|本地目录> --dry-run   # 先看会写哪些文件
dia persona add <id> --from <git URL|本地目录>             # persona 是外部资产，必须显式装
dia persona default <id>           # 可选：设成宿主默认 agent
```

- **persona 必须显式安装**（包里不带 persona）；内置能力不需要手动装。
- 没有 persona 时 `dia kb` 以当前目录为知识根 —— 指定 `--root DIR` 或先装 persona。
<!-- gen:quickstart:end -->

<!-- gen:update:start -->
## 更新

```bash
dia update --check     # 有新版 → exit 1
dia update             # npm 安装：自动 npm i -g，并在进程内补齐内置能力
```

- 其它包管理器：`bun add -g @minonl/dia@latest` / `pnpm add -g @minonl/dia@latest`，然后 `dia postinstall`。
- `dia update` 只自动补内置 `dia-msg`；有新的内置能力时以 `dia postinstall` 收口（`dia doctor` 的 `bootstrap` 会提示）。
<!-- gen:update:end -->

<!-- gen:uninstall:start -->
## 卸载

按顺序：**先让 dia 把自己的产物摘干净，再删 CLI 和数据**。

```bash
# 1) persona 与默认 agent
dia persona default --show          # 若默认 agent 是 dia 装的 persona，先复位
dia persona default --unset
dia persona list                    # 逐个移除；手改过的产物会 skip，按提示手删
dia persona remove <id>

# 2) 内置能力（删 3 个 skill 软链 + ~/.dia/kits/dia-msg）
dia collab disable

# 3) CLI 本体（用当初安装它的那个包管理器）
npm uninstall -g @minonl/dia        # bun remove -g / pnpm remove -g

# 4) 数据根（不可逆；先看一眼里面有什么）
ls ~/.dia && cp -a ~/.dia ~/dia-backup-$(date +%Y%m%d)
rm -rf ~/.dia
```

- 数据根 `~/.dia` 里有 persona、kit、消息、审计、任务与索引；**删之前先备份**。
- 宿主渲染产物（不随上一步删除）：`~/.config/opencode/agents/<id>.md`、`~/.dsh/profiles/<id>/`、persona 声明的 `~/.agents/skills/<name>`。
- 旧机器残留可一并清理：`~/.local/share/dia`（已退役的脚本安装）、`~/.local/state/dia`、`~/.cache/dia`。
<!-- gen:uninstall:end -->

## 开发

```bash
bun test tests          # 单元测试
bun run build           # 生成 dist/cli.js（Node 可运行）
bash tests/smoke.sh     # 用 Node 跑一遍构建产物
bun src/cli.ts version  # 直接跑源码
```

### CI 矩阵（`.github/workflows/test.yml`）

| job | 触发 | 是否 required | 说明 |
|---|---|---|---|
| `test (ubuntu-latest)` | PR | ✅ | 全量：单测 / kb / job / build / install / smoke / e2e |
| `test (macos-latest)` | PR | ✅ | 同上（**macOS 特有差异只有这里能抓到**，例如没有 `timeout(1)`） |
| `windows-smoke` | PR（代码改动） | ❌ 非阻塞 | 装依赖 + `dia --version` + 纯逻辑测试；`dia job` 的 Windows 后端尚未实现（`install` 返回 rc=3），落地后再升 required |
| `changes` | PR | ❌ | 判定改动是否只碰 `docs/**` / `llms*.txt`：是则跳过测试矩阵（docs-only 快通道） |

> 只在 `pull_request` 上跑（不再对特性分支的 push 重复跑）。
> 改这里时**保持 `test (…)` 的 job 名不变**——分支保护按名字要求这两个 check。

<!-- gen:commands:start -->
## 命令

`dia --help` 是完整清单（本节由它生成）。

| 命令 | 用法 | 说明 |
|---|---|---|
| `kb` | `dia kb index [--root DIR] [--db PATH] [--json]` |  |
| `kb` | `dia kb search <query> [--root DIR] [--db PATH] [--limit N] [--json]` |  |
| `kb` | `dia kb query <query> [--root DIR] [--db PATH] [--limit N] [--json] [--full] [--bytes] [--auto-index]` |  |
| `kb` | `dia kb review [--root DIR] [--db PATH] [--json]` |  |
| `kb` | `dia kb path <doc:...|workflow:...|skill:...|tool:...` | mode> [--root DIR] [--repo DIR] [--json] |
| `kb` | `dia kb lint [--root DIR] [--db PATH] [--stale-days N] [--json] [--strict]` |  |
| `kb` | `dia kb get <path> [--root DIR] [--section HEADING]` |  |
| `--persona` | `dia --persona ID kb <cmd>` | persona 作用域：知识根/数据根/域命令委派 |
| `ingest` | `dia ingest sessions [--source dsh|opencode|all] [--domain dabo|yan] [--since ISO] [--full] [--limit N] [--dry-run] [--out DIR] [--project ID] [--json]` |  |
| `ingest` | `dia ingest git --repo DIR [--since DATE] [--limit N] [--json]` |  |
| `audit` | `dia audit append --session S --tool T [--decision allow|deny|waive] [--params JSON] [--risk N] [--redline] [--note ...] [--json]` |  |
| `audit` | `dia audit verify --session S --calls N [--chain] [--json]` |  |
| `audit` | `dia audit score --session S [--json]` |  |
| `audit` | `dia audit tail [--n 20] [--json]` |  |
| `freeze` | `dia freeze --reason R [--auto] [--last-episode ID] [--json]` |  |
| `freeze` | `dia freeze status` |  |
| `freeze` | `dia freeze thaw --reason R --i-am-human` |  |
| `guard` | `dia guard [--once] [--json]` |  |
| `run` | `dia run --session S [--tool T] [--agent A] [--waive --risk N] [--redline] -- <cmd> [args...]` |  |
| `resume` | `dia resume --session S [--json]` |  |
| `persona` | `dia persona add <id|--from SRC> [--ref REF] [--host opencode|dsh|codex] [--home DIR] [--dry-run] [--force] [--json]` |  |
| `persona` | `dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--no-msg] [--dry-run] [--json]` |  |
| `persona` | `dia persona render <id> [--host opencode|dsh|codex] [--home DIR] [--check] [--json]` |  |
| `persona` | `dia persona list|verify|remove|show <id>|use <id>[@ver]` |  |
| `persona` | `dia persona path [<id>[@<ver>]] [--json]` | 打印生效版本目录（服务/脚本取代码入口） |
| `persona` | `dia persona check <id>|update <id> [--ref REF]` |  |
| `doctor` | `dia doctor [--persona ID] [--paths] [--json]` |  |
| `deps` | `dia deps list [--json] [--file PATH]` | 派生视图：登记 + 实测 |
| `deps` | `dia deps record --id ID --kind K --version V [--resolved R] [--role required|optional] [--result pass|fail|unknown] [--evidence P]` |  |
| `env` | `dia env list|check [KEY…] | env [--dry-run] [--redact] <cmd…>` |  |
| `env` | `dia env bw status|unlock [--passwordfile P]|lock` |  |
| `env` | `dia env bw run --map KEY=item [--map …] [--task T] -- <cmd…>` | 只注入映射键；BW_SESSION 不进子进程 |
| `env` | `dia env bw serve [--socket PATH] [--passwordfile P]` | 常驻 broker（可启动时解锁） |
| `env` | `dia env bw get --item ITEM [--env KEY] [--task T] [--json]` |  |
| `persona` | `dia persona default <id>|--unset|--show [--host opencode]` |  |
| `kit` | `dia kit add --from SRC [--ref REF] [--dry-run] [--json]` |  |
| `kit` | `dia kit list|verify <id>|remove <id>` |  |
| `service` | `dia service add (<--from SRC> | --dir DIR) [--ref REF] [--dry-run] [--json]` |  |
| `service` | `dia service list [--json] | show <id> [--json] | verify <id|--dir DIR> [--json]` |  |
| `service` | `dia service health <id> [--from-wrapper --exit N --gen G] [--json]` | 0 ok/30 degraded/1 fail/31 判据不可用/2 用法 |
| `service` | `dia service remove <id> [--json]` |  |
| `wt` | `dia wt create|form|list|status|check|route|scope|clean|prune-merged …` |  |
| `cmd` | `dia cmd <name> [args…]` | 只查 persona 声明的命令（可绕开同名内置） |
| `<persona-cmd>` | `dia <persona-cmd> [args…]` | 一级委派（内置优先） |
| `collab` | `dia collab status|enable|disable [--persona ID]` | dia-msg 默认能力开关（默认开） |
| `collab` | `dia collab stats [--since 7d] [--by session|pair|class] [--json]` | 只读聚合（送达/回复/积压） |
| `collab` | `dia collab board [--cached|--refresh] [--json] | observe [--interval 300] [--json]` | 一次性 tick/看板（无常驻；定时用 dia job） |
| `whoami` | `dia whoami [--json] [--name NAME]` | 当前会话身份（session id） |
| `in` | `dia in [--unread] [--all] [--legacy] [--class P0,P1] [--sort priority|arrival] [--expose] [--json]` | 会话收件箱（正文内联） |
| `out` | `dia out --to <session_id> --subject S (--body B|--body-file F) [--kind K] [--touch p1,p2] [--reply-to ID]` |  |
| `ack` | `dia ack <id> | dia reply <id> --body B | dia close <id> --reason R | dia show <id>` |  |
| `msg` | `dia msg send|show|inbox|ack|delivered|deliver [--wait]|reply|needs-info|status|stuck|thread|escalate|agents|migrate` |  |
| `agents` | `dia agents list|register|unregister|discover` |  |
| `msg` | `dia msg deliver <agent> <id> [--transport tmux|acp]` |  |
| `task` | `dia task add|list|link|plan|split|status|done [--owner S] [--depends a,b] [--touches p1,p2] [--prio P1] [--start D] [--due D] [--progress 0-100]` |  |
| `task` | `dia task split <id> --into "切片A,切片B" [--slice 切片A] [--role R] [--judge J] [--touches p] [--force]` |  |
| `graph` | `dia graph [--json] [--task t-...] [--tui [--watch] [--status S] [--owner S] [--width N] [--no-color]]` |  |
| `graph` | `dia graph --export-html [path] [--out path] [--now ISO] [--redact] [--all] [--limit N] [--force]` |  |
| `graph` | `dia graph --next [n] | --explain <id> | --lint` | 只读编排建议（Kahn-v1） |
| `claim` | `dia claim <path> [--reason R] [--ttl 4h] [--session S] | dia claims [--all] [--mine] [--gc [--days 7]] | dia unclaim <path|id> [--force]` |  |
| `team` | `dia team run <id> --mock | --acp|--dsh --workspace DIR` |  |
| `team` | `dia team gate|accept|reject|next` |  |
| `team` | `dia team accept <id> [--note ...] [--pr N [--repo R] [--merge]]` | --pr：先验 CI，绿才接受/合并 |
| `job` | `dia job <list|status|install|...>` | 调度适配器 |
| `price` | `dia price list|--json` |  |
| `postinstall` | `dia postinstall [--quiet]` | 装配内置能力（npm 拦截脚本 / ignore-scripts 时的兜底；幂等） |
| `migrate` | `dia migrate data [--from DIR] [--dry-run]` | 旧数据根 → 数据根（只搬数据子目录，合并同名目录） |
| `version` | `dia version` |  |
| `update` | `dia update [--check]` | 查/装 npm 最新版 |

更多文档见 [`docs/`](docs)。
<!-- gen:commands:end -->

常用路径（详细说明见 [`docs/cli.md`](docs/cli.md)）：

```bash
dia persona add|render|list|show|default     # 人格：装 / 渲染 / 设默认
dia kb index|search|query|lint|path          # 知识索引（--root 指定知识根）
dia wt create|check|clean                    # worktree 工作区
dia whoami / dia in / dia out                # 会话身份与消息
dia doctor / dia update --check              # 自检 / 查新版
```

### 采集产物

```
<out>/episodes.jsonl    # 每会话一条：时间区间 / 轮次 / 工具聚合 / 脱敏摘要 / 源引用
<out>/candidates.jsonl  # 有失败重试或关键词（修复/排查/迁移…）的候选
~/.dia/cache/ingest/state.json   # 增量水位（源 mtime / session 更新时间）
```

- **不落原文**：只存脱敏摘要 + `raw_ref`（`dsh:<session-id>` / `opencode:<id>`）。
- **只读源**：测试断言源文件 mtime 不变；框架源码禁止 `node:http(s)`/`node:net`（静态测试）。
- `origin` 自动标记 `work|personal`（按 workspace 路径），只存哈希不存路径。
- `--domain yan` 必须显式 `--i-own-this`。

## 验收

```bash
bun test tests                 # 约 500 条测试（69 个文件）
bash tests/smoke.sh            # 构建产物 + Node 冒烟
bash tests/e2e.sh              # E2E-1 管线验收（Node）
DIA_E2E_RUNTIME=bun bash tests/e2e.sh   # 同一套验收跑 Bun
```

E2E-1 覆盖：kb 索引/检索/lint → dsh+opencode 采集（幂等、脱敏）→ 审计对账 →
红线冻结 → guard 闸口（exit 42）→ agent 解冻被拒（exit 3）→ 人工解冻 → 源文件只读校验。
**未覆盖**：真实 agent 循环（谁写审计行）、H3 冻结续跑、npm 安装即用。

## 审计与冻结

```bash
# 包装执行：先过冻结闸口，执行后自动写审计（参数只存哈希）
dia run --session S -- bash -lc "npm test"
dia run --session S --redline --tool send -- ./send.sh   # 红线：执行后自动冻结
dia audit verify --session S          # 不传 --calls 时用 runtime 计数自动对账

# 冻结后恢复：给出续跑卡片（不重复已完成步骤）
dia resume --session S [--json]
# 每次工具调用写一条（参数只存哈希）
dia audit append --session S --tool bash --decision allow --params '{"cmd":"ls"}'
dia audit append --session S --tool send --decision deny --redline

# 对账：审计行数 >= 实际工具调用数
dia audit verify --session S --calls 12

# 完整性：逐行重算 prev_hash/hash 链（篡改/删行/乱序报 broken@N，退出码 1）
dia audit verify --session S --calls 12 --chain [--json]
# 链头锚点 audit/head.json（last_seq/last_hash/row_count）由 append 原子写入：
# 末尾删行/回滚报 tail_truncated，锚点缺失或损坏时 fail-closed（ok=false，退出码 1）

# 离箱检查点（可选但推荐）：锚点放到审计目录之外（另一个目录/文件系统/机器挂载）
# 启用前提（2026-11-03）：检查点必须是"新开"的（文件不存在）且日志从空开始，或检查点与当前日志尾部一致；
#   已有链的存量日志首次启用会 fail-closed 拒绝追加（防止把历史删改追认为合法）。迁移前先备份。
# 同域攻击者能同时重写日志与 head.json，却改不到这里 → 同域伪造/回滚会被检出
DIA_AUDIT_CHECKPOINT=/var/lib/dia-anchors/audit.json dia audit verify --session S --calls 12 --chain
# append 是两阶段写：先把将写入的行作为 pending 公告到检查点，行落盘+head 更新后再确认。
# 因此「追加链合法的新行 + 同步改写 head.json」会在检查点留下未被公告的行 →
#   protection=anchored:forged_same_domain（退出码 1），且 append 拒绝把伪造行追认为 consistent。
# 结论：protection=anchored:consistent
#       | anchored:lagging（仅当检查点公告了那行；崩溃窗口，仅告警）
#       | anchored:forged_same_domain / rolled_back（退出码 1）
#       | missing / corrupt / misconfigured（fail-closed，退出码 1）
#       | unprotected（未配置检查点，退出码不变，只是提示"仅同域保护"）
# 检查点写入失败 → append 抛 E_AUDIT_CHECKPOINT 并回滚本次追加，不留半条链

# 评分：deny+2 / waive+risk / 越界+4 / 未知工具+3 / 对账缺口+10 / 红线+10
dia audit score --session S

# 冻结 / 解冻
dia freeze --reason "redline" --last-episode <id>
dia freeze status          # frozen 时退出码 1
dia freeze thaw --reason "reviewed" --i-am-human
dia guard                  # frozen 时退出码 42，供 launchd/包装器闸口
```

- 冻结产物：`~/.dia/state/freeze.json` + `freeze-snapshot.json`（含 `last_episode` 与 `resume_hint`）。
- `thaw` 必须显式 `--i-am-human` + `--reason`；agent 侧调用被拒（H2 测试：连续 10 次全部失败）。
- **诚实边界**：同用户同权限下，冻结是**软约束**；真隔离要配合 dsh sandbox（禁止写 `~/.dia/state`）。
- 规则：`score >= 3` 警告、`>= 10` 自动冻结、红线直接冻结。
- `dia run` 冻结时**不执行**，直接 exit 42；子进程退出码原样透传。
- `dia resume` 在冻结期间拒绝（exit 42）；解冻后输出 `completed_runs / last_run / last_failure / audit_ok`，
  `resume_hint` 明确"不要重复已完成步骤，失败步骤可重试"（H3）。
- 原始命令与参数**不落盘**，只存 16 位哈希；子进程环境带 `DIA_SESSION` / `DIA_RUN_ID`。

## 基线（对 yan-agent 现有知识库，2026-10-27）

```
docs 103 | bytes 910005 | tokens≈245012
index covered: 74 | missing: 29
review missing: 103 | overdue: 0
broken links: 5
```

这套数字保留为历史基线；当前实现是 TS/Bun，不再维护 Python 原型
（token 估算允许 ±0.1% 差异，原因是 JS 按 UTF-16 计长、Python 按码点）。

## 原则

1. **md 是唯一事实源**；`index.db` 是派生物，删掉必须能重建，且重建结果可复现。
2. 索引/复审/断链由工具生成，不靠人手维护。
3. SQLite 只放派生索引与会话状态，不放"人类知识"。
4. 采集只在本机；跨域只共享方法，不共享数据。

## 状态

**先看 [`docs/status.md`](docs/status.md)**：设计支柱 × 证据 × 判决、计划状态、待决策。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 框架 / 场景入口 / 能力包 三层 |
| `docs/evolution-process.md` | 进化过程模型：(T,D,O)、V 型、深度、压缩 |
| `docs/security-sandbox.md` | sandbox 设计：单 seam、默认档位、fail-closed |
| `docs/ecosystem-integration.md` | 五家扩展模型、ACP/MCP、包格式 |
| `docs/ecosystem-positioning.md` | 生态定位：常驻入口、接谁不接谁 |
| `docs/entrypoints.md` | 用户入口：终端 / IM / 控制面，agent 名是 dabo |
| `docs/persona-install.md` | 用 dia 从 git 地址安装 persona/kit |
| `docs/versioning.md` | 多版本、semver/双重审查、激活模式、通知 |
| `docs/patching.md` | 本地 patch：格式、应用、重放、安全 |
| `docs/pricing.md` | tokens → 金额与预算 |
| `docs/proposals.md` | 目标提案（team next）：只提候选，不立项 |
| `docs/cli.md` | CLI 动作词表与退出码 |
| `docs/host-control-surface.md` | opencode/dsh 的控制面（L0/L1/L2） |
| `docs/model-behavior.md` | 客户端模型调控（六类杠杆、五家对照） |
| `docs/model-baseline-sidecar.md` | 首次基准 + sidecar 漂移监控 |
| `docs/research/benchmarks-survey.md` | 开源基准清单、污染与私有 canary |
| `docs/research/opencode-session-scoping.md` | opencode v2 会话分区（Project/Location/Workspace） |
| `docs/dependency-registry.md` | 外部依赖登记与原始记录维护 |
| `docs/research/collaboration-theory.md` | 人机协作与评估的理论依据 |
| `docs/deps.jsonl` | 当前依赖登记（可执行实例） |
| `docs/review/reuse-review.md` | 复用裁决与 probe 记录 |

## 状态

- ✅ `kb index/search/lint/get`（Bun + Node 双运行时验证）
- ⏳ `ingest`（dsh zstd + opencode sqlite，脱敏后归一）
- ⏳ 审计 / 冻结 / 豁免
