# dia（嗲）

轻量 agent 框架：**预设注入 + 知识索引 + 审计/止血 + 会话采集**。

> 定位：dabo-agent（个人域）与 yan-agent（工作域）共用的底层能力。
> 设计见 [`docs/architecture.md`](docs/architecture.md)，启动方案见 [`docs/framework-bootstrap.md`](docs/framework-bootstrap.md)。

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
原因不是性能，是分发（**计划**公开 npm；当前 `private: true`，发布前需移除）与生态（opencode/dsh 同为 TS/Node）。
Python 原型已完成使命（行为对齐后删除）；其基线数字保留在下方「基线」。

> 注：opencode 自带运行时（可在无 Node 的机器上跑），dsh 依赖 Node。
> 因此 npm 包声明 `engines.node >= 24`；无 Node 的机器后续用 `bun build --compile` 的单文件二进制。

## Public release

**当前 private。转为 public 前必须通过 `docs/security/public-release.md` 的硬门禁**：
当前树脱敏、Git 历史清洁、GitHub 元数据检查、`dia-security` 独立审核 `pass`。
未通过前不得改 visibility。

## 安装

```bash
git clone https://github.com/minonl/dia ~/repos/github/dia
cd ~/repos/github/dia
bun install && bun run build      # 或 npm ci + npm run build（Node ≥ 24）
bash install.sh                   # → ~/.local/share/dia + ~/.local/bin/dia
dia version && dia doctor
```

- 依赖：Node ≥ 24 或 Bun ≥ 1.2（见 `package.json` 的 `engines`）。
- 安装只落盘：**不启停服务、不改宿主默认 agent**。
- 装 persona（示例 dabo）：`dia persona add dabo --from git+https://github.com/minonl/dabo-agent.git`
- 卸载：`dia persona remove dabo`（只删带 `.dia-managed` 的产物）。

## 开发

```bash
bun test tests          # 单元测试
bun run build           # 生成 dist/cli.js（Node 可运行）
bash tests/smoke.sh     # 用 Node 跑一遍构建产物
bun src/cli.ts version  # 直接跑源码
```

## 命令

```bash
# persona / kit（作者轴 + 安装轴）
dia persona create <id> --dir DIR [--host opencode|dsh] [--dry-run]   # 生成骨架（不联网、不执行脚本）
dia persona add <id> --from git+... | DIR [--ref REF] [--dry-run]     # 取回 + 渲染 + 记 lock
dia persona render <id> [--host opencode|dsh] [--check]               # 用已装版本重渲染（--check 只报 drift）
dia persona verify|list|show|remove|use|path|update
dia kit add --from SRC [--ref REF]

# 知识
dia kb index  [--root DIR] [--db PATH] [--json]
dia kb search <query> [--root DIR] [--db PATH] [--limit N] [--json]
dia kb lint   [--root DIR] [--db PATH] [--stale-days N] [--json] [--strict]
dia kb get    <path> [--root DIR] [--section HEADING]

# 会话采集（只读源；本机处理；默认可重跑增量）
dia ingest sessions [--source dsh|opencode|all] [--domain dabo|yan] \
                    [--since ISO] [--full] [--limit N] [--dry-run] \
                    [--out DIR] [--cache-dir DIR] [--json]

# 仓库更新时间点（与采集结果按时间对齐）
dia ingest git --repo DIR [--since "14 days ago"] [--limit N] [--json]

dia version
```

### 采集产物

```
<out>/episodes.jsonl    # 每会话一条：时间区间 / 轮次 / 工具聚合 / 脱敏摘要 / 源引用
<out>/candidates.jsonl  # 有失败重试或关键词（修复/排查/迁移…）的候选
~/.cache/dia/ingest/state.json   # 增量水位（源 mtime / session 更新时间）
```

- **不落原文**：只存脱敏摘要 + `raw_ref`（`dsh:<session-id>` / `opencode:<id>`）。
- **只读源**：测试断言源文件 mtime 不变；框架源码禁止 `node:http(s)`/`node:net`（静态测试）。
- `origin` 自动标记 `work|personal`（按 workspace 路径），只存哈希不存路径。
- `--domain yan` 必须显式 `--i-own-this`。

## 验收

```bash
bun test tests                 # 19 个单元测试
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

# 评分：deny+2 / waive+risk / 越界+4 / 未知工具+3 / 对账缺口+10 / 红线+10
dia audit score --session S

# 冻结 / 解冻
dia freeze --reason "redline" --last-episode <id>
dia freeze status          # frozen 时退出码 1
dia freeze thaw --reason "reviewed" --i-am-human
dia guard                  # frozen 时退出码 42，供 launchd/包装器闸口
```

- 冻结产物：`~/.local/state/dia/freeze.json` + `freeze-snapshot.json`（含 `last_episode` 与 `resume_hint`）。
- `thaw` 必须显式 `--i-am-human` + `--reason`；agent 侧调用被拒（H2 测试：连续 10 次全部失败）。
- **诚实边界**：同用户同权限下，冻结是**软约束**；真隔离要配合 dsh sandbox（禁止写 `~/.local/state/dia`）。
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
| `docs/deps.yaml` | 当前依赖登记（可执行实例） |
| `docs/review/reuse-review.md` | 复用裁决与 probe 记录 |

## 状态

- ✅ `kb index/search/lint/get`（Bun + Node 双运行时验证）
- ⏳ `ingest`（dsh zstd + opencode sqlite，脱敏后归一）
- ⏳ 审计 / 冻结 / 豁免
