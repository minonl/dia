# 宿主控制面：黑盒边界与内部 seam（2026-10）

> 日期 2026-10-28。问题：把 opencode（含 v2）与 dsh 当"黑盒宿主"时，我们能在哪些边界上控制它们？
> 结论先行：**优先黑盒（CLI/HTTP/ACP/配置/会话只读）；插件 seam 只用于观测；永不 patch 宿主。**

---

## 0. 三层边界

| 层 | 形态 | 稳定性 | 用途 |
|---|---|---|---|
| **L0 黑盒** | CLI、HTTP API、ACP、配置文件、会话存储（只读） | 高（有版本契约） | 启动、查询、注入配置、读真相 |
| **L1 插件 seam** | 宿主内部的 hook/事件/生命周期 | 中（API 会断代） | 观测、轻量改写、审批 |
| **L2 侵入** | patch 宿主源码 / fork | 低 | **禁止** |

---

## 1. opencode（v2 为重点）

### 1.0 v2 拓扑（重要修正）

opencode v2 **不是"TUI 里跑 agent"**，而是 daemon 化：

```
TUI / CLI / Web / SDK  ← 都是客户端
        │  同一 HTTP 契约（OpenAPI 3.1）
        ▼
用户级共享后台 server（daemon）
  ├─ sessions / config / permissions / tool execution
  ├─ LocationServiceMap（每 workspace 的 fs/tools/agents/providers/MCP）
  └─ durable event log + projections + pending inbox
```

- 默认自动发现/启动**一个用户级共享 server**；`--standalone` 起私有 server；`--server` 连远端。
- 桌面版用 **Electron utility-process sidecar** 跑同一个 server（不是通用插件沙箱）。
- 官方 issue #43898 明确："one shared OpenCode process for all workspaces and clients"，并承认多 workspace 隔离/公平性**没有契约**。
- `opencode-forge`（第三方，13★，MIT）是 server+TUI 双面插件，做自主循环/worktree 沙箱；**不是核心能力**。

**含义**：
1. 会话与 TUI 进程分离 → 我们读会话不必附着 TUI。
2. 共享 daemon 是单点：一个 workspace 的重负载会影响所有客户端（#43898 实测 TUI 卡顿）。
3. 需要隔离时只有三种选择：`--standalone`（私有 server）、`--server` 远端、或嵌入式 SDK（`@opencode/sdk`，内存 router，无监听）。

### 1.0.1 会话分区：Project / Location / Workspace

| 概念 | 定义 | 证据 |
|---|---|---|
| **Project** | 工作目录的身份：Git 仓跟随 worktree 根；非 Git 目录在 V2 各自成 project（V1 统一为 `global`） | 官方指南 + 本机 DB `project_id` 分布 |
| **Location** | 每次请求的目录上下文：fs/tools/agents/providers/MCP 都挂在 `LocationServiceMap` 下 | V2 spec |
| **Workspace** | 可选、实验性：session 可绑定 `workspace_id`（worktree） | 测试代码 + 本机 `workspace_id` 全为 NULL |

**行为**：
- `opencode ~/proj` → 切到该 project；`opencode`（不指定）→ 默认 location（server cwd）。
- TUI 的 `/sessions` 与 `opencode session list` 都**只列当前 project 的顶层会话**；子会话不出现。
- `session list` **没有 `--all`**；要跨 project 只能走 API：`GET /api/session`（支持 `scope/directory/path/workspaceID/roots`）。
- `--continue` 只挑"记录目录 = 当前目录"的最新顶层会话。
- V1 的 `global` project 会话在 V2 picker 里**看不到**，需要 `GET /api/session` 或 move API 修。

**对 dia 的含义**：
1. 采集不能只靠 `session list`——会漏跨 project/迁移会话；必须用 API 或直接读 DB，并记录 `project_id/directory/path/workspace_id`。
2. **Project 不是安全边界**：共享 daemon 拥有全部会话，API 可跨 project 读；隔离要靠 `--standalone`/`--server`。
3. `workspace_id` 目前为空（实验特性）；不要把"session 绑定 worktree"当成现成能力。

### L0 黑盒

| 能力 | 入口 | 证据 |
|---|---|---|
| 任意 API 调用 | `opencode api <operation | METHOD path>`（OpenAPI 操作） | 本机 `--help` · A |
| 会话管理 | `opencode session ...` | 本机 · A |
| MCP 管理 | `opencode mcp ...` | 本机 · A |
| 插件管理 | `opencode plugin add/list/check` | 本机 · A |
| ACP 服务 | `opencode acp` | 本机 · A |
| 配置 | `opencode.jsonc`、`agents/*.md`、`plugins/` | 本机 · A |
| 真相读取 | `~/.local/share/opencode/opencode.db`（只读） | 本机 · A |

### L1 插件（V2）

| 能力 | 形式 | 状态 |
|---|---|---|
| 工具前后 | `ctx.tool.hook("execute.before"/"after")` | 官方 V2 |
| 会话上下文/压缩 | `ctx.session.hook("context"/"compaction")` | 官方 V2 |
| 事件订阅 | `ctx.event.subscribe()` | 官方 V2 |
| Agent 注册/改写 | `ctx.agent.transform()` | 官方 V2 |
| 权限 | `permission.hook("evaluate")` | **实测返回值不生效**（yan-oc-guard 注释，A 级） |
| shell 前后 | `shell.hook("before")` | 本机插件在用 |

**结论**：opencode 只适合做**观测 + 审计**，不适合做强制拦截；强制控制必须由外部（dia run / dsh）承担。
V1→V2 是断代（"V1 implementations do not run in V2"），插件 API 必须按版本探测。

---

## 2. dsh

### 1.0 v2 拓扑（重要修正）

opencode v2 **不是"TUI 里跑 agent"**，而是 daemon 化：

```
TUI / CLI / Web / SDK  ← 都是客户端
        │  同一 HTTP 契约（OpenAPI 3.1）
        ▼
用户级共享后台 server（daemon）
  ├─ sessions / config / permissions / tool execution
  ├─ LocationServiceMap（每 workspace 的 fs/tools/agents/providers/MCP）
  └─ durable event log + projections + pending inbox
```

- 默认自动发现/启动**一个用户级共享 server**；`--standalone` 起私有 server；`--server` 连远端。
- 桌面版用 **Electron utility-process sidecar** 跑同一个 server（不是通用插件沙箱）。
- 官方 issue #43898 明确："one shared OpenCode process for all workspaces and clients"，并承认多 workspace 隔离/公平性**没有契约**。
- `opencode-forge`（第三方，13★，MIT）是 server+TUI 双面插件，做自主循环/worktree 沙箱；**不是核心能力**。

**含义**：
1. 会话与 TUI 进程分离 → 我们读会话不必附着 TUI。
2. 共享 daemon 是单点：一个 workspace 的重负载会影响所有客户端（#43898 实测 TUI 卡顿）。
3. 需要隔离时只有三种选择：`--standalone`（私有 server）、`--server` 远端、或嵌入式 SDK（`@opencode/sdk`，内存 router，无监听）。

### 1.0.1 会话分区：Project / Location / Workspace

| 概念 | 定义 | 证据 |
|---|---|---|
| **Project** | 工作目录的身份：Git 仓跟随 worktree 根；非 Git 目录在 V2 各自成 project（V1 统一为 `global`） | 官方指南 + 本机 DB `project_id` 分布 |
| **Location** | 每次请求的目录上下文：fs/tools/agents/providers/MCP 都挂在 `LocationServiceMap` 下 | V2 spec |
| **Workspace** | 可选、实验性：session 可绑定 `workspace_id`（worktree） | 测试代码 + 本机 `workspace_id` 全为 NULL |

**行为**：
- `opencode ~/proj` → 切到该 project；`opencode`（不指定）→ 默认 location（server cwd）。
- TUI 的 `/sessions` 与 `opencode session list` 都**只列当前 project 的顶层会话**；子会话不出现。
- `session list` **没有 `--all`**；要跨 project 只能走 API：`GET /api/session`（支持 `scope/directory/path/workspaceID/roots`）。
- `--continue` 只挑"记录目录 = 当前目录"的最新顶层会话。
- V1 的 `global` project 会话在 V2 picker 里**看不到**，需要 `GET /api/session` 或 move API 修。

**对 dia 的含义**：
1. 采集不能只靠 `session list`——会漏跨 project/迁移会话；必须用 API 或直接读 DB，并记录 `project_id/directory/path/workspace_id`。
2. **Project 不是安全边界**：共享 daemon 拥有全部会话，API 可跨 project 读；隔离要靠 `--standalone`/`--server`。
3. `workspace_id` 目前为空（实验特性）；不要把"session 绑定 worktree"当成现成能力。

### L0 黑盒

| 能力 | 入口 | 证据 |
|---|---|---|
| 启动 profile | `dsh --profile <name>` | 本机 · A |
| 组合树查询 | `--dump-config` / `--dump-default-config` | 本机 · A |
| 插件安装 | `dsh plugin --profile <p> add <pkg>`（转发 pnpm） | 本机 · A |
| ACP | `dsh-acp-app`（JSON-RPC stdio） | 包描述 · A |
| 会话真相 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 本机 · A |
| 会话控制 | `dsh-api-session-controller`（remote commands / cold reads / live transport） | 包描述 · A |

### L1 插件 seam（Cordis bundle）

| 能力 | 包 | 说明 |
|---|---|---|
| 执行前决策 | `tools/pre-execute`（watchdog） | 可判定/记账 |
| 审批拦截 | `approval/request` | 可回 `allowed-once` |
| 结果处理 | `tools/result` | 清理/记录 |
| 循环控制 | `dsh-agent-loop` | 步数/停止条件 |
| 重试 | `dsh-llm-retry` | 次数/退避/`providerRetryAfterMs` |
| 压缩 | `dsh-compaction-basic` + `tool-result-pruner` | 阈值/保留/无模型裁剪 |
| 权限预设 | `dsh-permission-presets` | sandbox-mode + approval 两轴 |
| 沙箱 | `dsh-sandbox*` | 文件效果，fail-closed |
| 断点 | `dsh-session-checkpoint-policy` | 模型请求/工具副作用前 |
| 重复调用 | `dsh-repeat-tool-reminder` | 防死循环 |
| 会话事件 | `dsh-session`（event-sourced，fold/fork） | 只追加、可重放 |

**结论**：dsh 是**可强制**的一侧：pre-execute + approval + sandbox + checkpoint 都在插件边界上，且 fail-closed。

---

## 3. 能力矩阵（我们要的控制 × 宿主）

| 控制需求 | opencode L0 | opencode L1 | dsh L0 | dsh L1 |
|---|---|---|---|---|
| 启动/停止会话 | ✅ `session` / `api`（共享 daemon） | — | ✅ CLI | — |
| 读会话真相 | ✅ sqlite 只读 / API | ✅ 事件 | ✅ 文件 | ✅ event store |
| 注入配置 | ✅ config/agents | ✅ transform | ✅ profile/patch | ✅ bundle |
| **拦截工具调用** | ❌ | ❌（hook 不生效） | ⚠️ 外部 wrapper | ✅ pre-execute/approval |
| 观测工具调用 | ❌ | ✅ | ⚠️ | ✅ |
| 强制沙箱（文件） | ❌ | ❌ | ⚠️ 仅 dsh 内 | ✅ sandbox |
| 断点续跑 | ❌ | ⚠️ | ⚠️ | ✅ checkpoint |
| 成本/重试控制 | ❌ | ⚠️ | ⚠️ | ✅ llm-retry |
| ACP 驱动 | ✅ server | — | ✅ server | — |

---

## 4. 决策规则

1. **能走 L0 就不走 L1**：配置/CLI/ACP 有版本契约；插件 API 会断代。
2. **强制控制放 dsh**：opencode 的 permission hook 只能观测（实测），不要把安全承诺建在它上面。
3. **L1 只做观测与审计**：除非有官方文档明确"可阻断"，否则一律按"观测"实现，并用一次实跑验证。
4. **永不 L2**：patch 宿主会导致升级即坏（dsh patch 覆写 preset 已出过事故）。
5. **每条控制面都要登记**：进 `deps.jsonl` 的 `kind: host_cli` 条目，记 version + verified_at。

---

## 4.1 轻量复用的两种接法（推荐）

| 接法 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 共享 daemon**（默认） | dia 调 `opencode api` / `service status`；不自己起进程 | 零额外进程、会话可复用 | 单点、公平性无契约、版本耦合 |
| **B. 嵌入式 SDK** | `@opencode/sdk` 的 `OpenCode.create()`，内存 router，无 HTTP 监听 | 无端口、隔离好 | 依赖 TS/Bun + 版本锁定 |
| **C. 私有 server** | `opencode serve --port ...` 每域一个 | 隔离与故障边界清晰 | 多进程、资源占用 |
| **D. dsh one-shot** | `dsh headless` 每任务一次 | 最轻、无常驻 | 无会话连续性 |

**选择规则**：
- 交互式长会话 → A（共享 daemon）或 C（需要隔离时）；
- 批处理/canary/基准 → D（dsh one-shot）；
- 需要"无端口" → B（嵌入式 SDK），但只在版本锁定时用。

## 5. 对 dia 的直接含义

- **控制层**：dia 的 `run`/freeze/audit 走 L0（CLI + 配置 + 会话读取）；dsh 内用 L1 观测。
- **opencode 侧**：只承诺"观测与审计"，不承诺拦截；文档必须写清（doctor 待实现）。
- **跨版本**：opencode V1/V2、dsh rc 版本都进能力探测；探测失败 → 降级为 L0 只读。
