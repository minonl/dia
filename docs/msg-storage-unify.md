# msg 存储统一 + 分级日志留痕（2026-11-18）

> 状态：**实现完成，未 push / 未 merge**。分支 `feat/msg-storage-unify-r3`（worktree `.worktrees/msg-storage-unify-r3`）。
> 前情：同一工作树上另有一份未提交的 `feat/msg-storage-unify`（`.worktrees/storage-unify`），
> 本分支从其**未合并的 origin/main** 重新独立实现，不引用那份代码。

## 1. 为什么收口

在此之前 `dia msg` 按「to 是不是 `ses_*` 形状」分流成两套存储：

| 子命令 | 旧落点 |
|---|---|
| `msg send --to ses_x` / `ses_x` 位置参数 | v2 `~/.dia/collab/inbox/<sid>/` |
| `msg send <agent>` / `msg inbox <agent>` / ack / reply / close / thread / escalate / agents / delivered / needs-info | v1 `~/.dia/msg/<agent>/inbox/` |
| `msg deliver` | 日志写 v1 `~/.dia/msg/<agent>/deliver-*.log` |

两套状态机、两套 id 语义、两处要维护：新功能只能挑一边加，另一边永远半残。
2026-11-18 用户拍板：**统一到 v2 `~/.dia/collab/`，老数据一次性导入**，并且**不在 v1 上继续迭代**。

## 2. 废弃命令普查（结论三选一）

判定依据：全仓 `grep`（`docs/`、`kits/`、`scripts/`、`README.md`、`llms.txt`、CLI help）+
`~/.config/opencode/`（skill / 插件 / agent 定义）+ 语义是否已被 v2 覆盖。

| v1 子命令 | 还被引用吗 | v2 覆盖？ | 结论 |
|---|---|---|---|
| `msg send <agent>` | skill/docs 里都是 `--to <session_id>` 形态 | 是 | **删除**：非 `ses_*` 收件人直接 `E_USAGE` + 正确格式提示 |
| `msg inbox <agent>` | 仅 `docs/migrations/data-root-2026-11.md` 历史记录 | 是 | **删除**：位置参数报 `E_USAGE` |
| `msg ack/reply/close <agent> <id>` | skill 全部用 `<id>` + `--session` | 是 | **删除**：只接受 `<id>`，会话由 `--session`/`DIA_SESSION_ID` 决定 |
| `msg show <agent> <id>` | 同上 | 是 | **删除**：`show <id>`（另：`status` 成为它的别名） |
| `msg deliver <agent>` | CLI help / README / docs/index 各一处 | 是 | **保留（转调 v2）**：`deliver <ses_id> <id> --transport file\|tmux\|acp`，日志落 `collab/deliver/` |
| `msg delivered` | **零引用** | 是（transport 回写自动 done） | **删除**（`E_RETIRED` + 替代说明） |
| `msg needs-info` | **零引用** | 是（close/reply 语义） | **删除**（`E_RETIRED`） |
| `msg stuck` | **零引用** | 是（`collab board` / `msg stats` 积压） | **删除**（`E_RETIRED`） |
| `msg thread` | **零引用** | 是（`msg trace <id>`） | **删除**（`E_RETIRED`） |
| `msg agents` | 2 处（design 文档，且原注释已写「deprecation 提示」） | 是（`collab board` / `dia agents list`） | **删除**（`E_RETIRED`） |
| `msg migrate`（→ legacy 只读） | docs/msg-collab-m0*、design 文档 | 改为一次性导入 | **保留（改语义）**：v1 → v2 inbox，可回复；默认 dry-run |
| `msg status` | docs/design 一处 | `show` 等价 | **保留（别名）**→ `show` |
| `msg escalate --due` / `retry` / `upkeep` | 定时任务与 skill | v2 已有 | **保留**（本来就调 v2 `collab.escalateDue/retryDue/upkeep`） |
| `msg trace` / `stats` / `seen` | skill 主推 | v2 事件流 | **保留** |
| `msg dsh` | docs/status | 与存储无关 | **保留** |
| `msg analyze-storage` | — | 新增 | **新增**：只读体检 |

代码层面 `src/msg.ts`（v1 实现，260 行）**整份删除**；`src/tmux.ts` / `src/msg-acp.ts` 改为直接读写 v2。
`~/.dia/msg/` 只剩「旧数据来源」这一身份，由 `msg migrate` / `msg analyze-storage` 处理。

## 3. 日志分级（`src/log.ts`）

### 3.1 规格

- 级别：`verbose < debug < info < warn < error`；`off` 全关。
- **默认 `verbose`**（开发主力机默认全开 —— 用户明确要求）。
- 来源：`DIA_LOG_LEVEL`（大小写不敏感）；空/非法值回落 `verbose`；`trace` 按 `verbose`（老习惯兼容）。
- 通道：**stderr**（stdout 留给 `--json` 等结构化输出）。
- 单条 `< 4096B`：单字段先截断到 1KB（头尾保留 + `…(NB)…`），整条再硬截断（保级别与 scope 便于 grep）。
- 字段值单行化（`\n` → `⏎`），保证「一行一条」可 grep。
- **写失败静默**：与 `msg-events` 同语义，日志不能反过来打挂业务。
- `logger(scope)` 给带命名空间的 logger；`isEnabled(level)` 让调用方跳过高成本快照构造。

### 3.2 与 `msg-events.ts` 的分工（重要）

| | `msg-events.ts`（事件流） | `src/log.ts`（运行日志） |
|---|---|---|
| 读者 | 机器（`dia msg trace` / `stats`） | 人 |
| 格式 | JSONL，**稳定 schema** | 文本，无 schema 承诺 |
| 内容 | 状态迁移的**事实**（event/to_state/from_state/latency_ms/attempt/error_code） | 细节与快照（body_bytes、channel/reason、优先级依据、幂等命中、try 了几次…） |
| 开关 | 无开关（审计数据必须写） | `DIA_LOG_LEVEL` 可关 |
| 写失败 | 静默 | 静默 |

**结论**：关键状态迁移进事件流（trace/stats 依赖它，格式不能变）；
细节与业务快照进运行日志（按级别）。
同一个留痕点在两处各写一次是**有意为之**：结构化那半给机器，冗余那半给人。
没有用日志替换事件流，也没有把日志字段塞进事件流（会污染 trace 的字段语义）。

## 4. 留痕调用点集中（`src/trace.ts`）

改前：`events.log({...})` 直接散在 `collab.ts` **16 处**（send/tryTmux/tryWebhook/markExposed/markDeliveredBatch/ack/reply/close×2/escalateDue），
调用方要自己知道「这条事件要不要带 to_state」「写失败要不要管」。

改后：唯一入口 `trace.fact(e)`（事件流 + 按级别镜像到日志）+ `trace.snapshot(where, state)` / `trace.detail*()`（只进日志）。
业务代码只表达「发生了什么」，例如：

```ts
// 改前
events.log({ event: "acked", msg_id: id, thread_id: m.thread_id, actor: ..., to_state: "acked", latency_ms: ... });
// 改后
trace.snapshot("ack", { id, to: "acked", delivered: !!m.delivered_at, exposed: !!m.exposed_at });
trace.fact({ event: "acked", msg_id: id, thread_id: m.thread_id, actor: ..., to_state: "acked", latency_ms: ... });
```

**约束（已遵守）**：`trace.*` 全部返回 `void`、永不抛异常、**不同步阻塞在 IO 之外**；
没有任何业务分支依赖它，也没有加 `await`。留痕写失败 → 业务照常（有测试钉住）。

镜像级别：

| 事件 | 日志级别 |
|---|---|
| `send.rejected/failed` | warn |
| `send.accepted` / `acked` / `replied` / `closed` / `escalated` / `inject.failed` | info |
| `inject.attempted/verified` / `read.observed` / `context.exposed` | debug |
| `snapshot:*`（业务状态快照） | verbose |

## 5. 存储统一与老数据导入（`src/msg-import.ts`）

### 5.1 分派规则

`dia msg` 不再看「名字形状」：**收件人必须是会话 id**（`ses_xxx`，`session:ses_xxx` 前缀自动去掉）。

```
dia msg send ops --subject x        → E_USAGE（并打印正确格式与如何查对方 id）
dia msg send ses_b --subject x      → 落 ~/.dia/collab/inbox/ses_b/
dia msg send session:ses_b ...      → 同上（归一）
dia msg deliver ops m-1             → E_USAGE
```

身份（`from`）只认 `--session` / `DIA_SESSION_ID` / `OPENCODE_SESSION_ID`。
`--from` 仍接受（旧脚本），但**与当前会话不一致时直接拒绝** —— 否则任意进程都能伪装成别的会话。
（这是本次修复的安全回归：旧实现 `--from ses_victim` 会真的写成 ses_victim。）

### 5.2 导入规则

- 源：`~/.dia/msg/<agent>/inbox/*.json`；会话 id **只从 agent 目录名提取** `ses_[A-Za-z0-9]+`。
- 提不到 → 该目录进 `unresolved` 报告，**不导入、不猜**（标题/cwd/昵称一律不作数）。
- 目标已存在同 id → 跳过，**不覆盖**（保住已读/已回复状态）；因此重跑是幂等的。
- **不删旧文件**（旧目录留作第二份，确认无误后人工清理）。
- 默认 **dry-run**；只有 `--apply` 才写盘。
- 导入的消息**不是 legacy**：保留 state/requires_reply/hops/refs/created_at，可 `show`、可 `ack/reply/close`。
- v1 的 `body_file` 不沿用（旧临时路径多已失效）→ 标 `body_missing`，不静默丢消息、也不猜正文。
- id 必须过 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`（防 `../../escape` 这类路径穿越）。

### 5.3 新命令 `dia msg analyze-storage`（只读）

输出三段：v2（会话数/消息数/状态分布/legacy 数）、v1（每个目录的 files/提取到的 sid/可导入数/已导入数）、
events（文件数/行数/坏行/月份区间），外加 `verdict` 人话结论。**绝不写盘**。

## 6. 顺手修

| 问题 | 修法 |
|---|---|
| `migrate data` 的 `subs` 漏了 `collab` | 加进 `subs`（否则 `~/.local/share/dia/collab` 不会被搬） |
| `dia msg deliver` 日志写 v1 root（`~/.dia/msg/<agent>/`） | 改到 `~/.dia/collab/deliver/deliver-<id>.log` |
| `--from` 可伪造发送方身份 | 与当前会话不一致 → `E_USAGE` 拒绝 |
| `ack` 事件丢 `from_state` | 补上（trace 之前少一列） |

## 7. 测试

新增：
- `tests/log-levels.test.ts` —— 级别解析（含 off/silent/trace/非法值回落）、单条 <4KB、字段头尾截断、换行单行化、Error 渲染。
- `tests/msg-storage-unify.test.ts` ——
  - 日志分级端到端（默认全量 / `info` 无 verbose / `error` 静默 / `off` 全静默，且 stdout 仍是纯 JSON、业务照常落盘）；
  - 事件流与人可读日志分工（`DIA_LOG_LEVEL=off` 时事件流照写、`trace` 照常输出、事件含 `to_state`/`latency_ms`）；
  - **日志通道坏掉业务照常**（stderr 丢弃）；
  - `migrate`：dry-run 不落盘 / `--apply` 后 show+reply / 幂等 / 旧文件保留；
  - 提取不到 sid → unresolved 报告、不导入、不崩；
  - `analyze-storage` JSON 与文本输出、只读性；
  - `migrate data` 会搬 `collab`。
- 改写（v1 → v2 口径）：
  - `tests/msg.test.ts`（send→inbox→show→ack→reply→trace 全链路、hops 上限、非 `ses_*` 报错、`session:` 前缀、下线子命令 `E_RETIRED`）
  - `tests/msg-acp.test.ts`（ACP 投递 + 异步投递日志落 `collab/deliver/` + `E_NO_ACP` + 非会话 id 报错）
  - `tests/collab.test.ts`（`msg migrate` 段重写为「一次性导入」；`--from` 伪造拒绝）
  - `tests/paths.test.ts`（改用 `msg send --to ses_*` 断言落 `~/.dia/collab/inbox/`）
  - `tests/agents.test.ts`（tmux 投递无 pane → `E_NO_PANE`；show 用会话语义）

## 8. 未测事项

- **macOS 未测**（本次只在 Linux 上跑）。
- `--transport tmux` 的真实注入只在 fake-tmux 下走过；真实 tmux pane 未在本次复测。
- `--transport acp` 用 `tests/fixtures/mock-acp.mjs` 验证；真实 dsh/opencode ACP 端到端未复测。
- 真实 `~/.dia/msg` 只跑了 `migrate --dry-run` 与 `analyze-storage`（**未 `--apply`**），见交付报告。
- 并发导入（两个 `msg migrate --apply` 同时跑）没有加锁：目前是单进程 CLI 场景；共用同一收件箱的多进程导入未测。
