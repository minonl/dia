# msg 子系统改造：ACP 通道 + 存储统一 + 分级日志

> 2026-11-18。PR [#226](https://github.com/minonl/dia/pull/226)。
> 范围：**仅 opencode v2 的 ACP**。dsh / codex / 其他 ACP 实现**未接、未测**。

## 1. 为什么做

### 起点：消息发了没人收到
在 WSL2（无 tmux）上 `dia msg send` 给 3 个活着的 opencode 会话，8 条全部停在 `state: pending`：

```
dia msg trace <id>  → (no events)
dia msg stats       → delivered=0 attempted=0 orphan=1
```

### 根因（两个，独立的）
1. **通道**：`notify()` 只试 tmux，`pane` 为空就直接 `mailbox-only`，**零事件** → 静默失败
2. **存储**：`send` 与 `inbox` 读写不同路径
   - `dia msg send <agent名>` → v1 `~/.dia/msg/<agent>/inbox/`
   - `dia msg inbox` → v2 `~/.dia/collab/inbox/<sid>/`
   - 两者永不相交；且 `looksSession()` 判否就走 v1

## 2. ACP 通道

### opcene v2 的 session/load

```ts
init() → session/load { sessionId, cwd, mcpServers: [] } → session/prompt
```

**在同一个 ACP 连接内完成三步**。这是关键：`session/load` 与 `session/prompt` 分在两个 `opencode acp` 进程里跑会报
`-32602 session not found`（实测于 opencode 2.2.6 / WSL，未在其他版本/环境验证）。

### 命令来源：`DIA_ACP_CMD`
- `whoami()` 从环境变量读入 `SessionRecord.acp_cmd`
- **不设就不走 ACP**，不探测进程、不按 host 猜
- 只对 `host === "opencode"` 生效

### 异步语义
`send` 立刻返回 `notified=acp(queued)`，后台 detached 子进程跑一轮 ACP。
不走同步是因为实测 prompt 最长约 120s，阻塞 `send` 不可接受。

子进程日志落 `~/.dia/collab/deliver/acp-auto-<id>.log`（手动投递是 `deliver-<id>.log`）。

### 失败一定有事件
| 事件 | 含义 |
|---|---|
| `inject.attempted` | 开始尝试 |
| `inject.verified` | ACP 一轮成功 |
| `inject.failed` | 失败，带 `error_code` |

`error_code` 取值：`E_ACP_SPAWN`（二进制不存在/不可执行）、`E_ACP_NO_SESSION`（-32602）、`E_ACP_TIMEOUT`、`E_ACP_EXITED`、`E_NO_ACP`、`E_NO_CHANNEL`。

## 3. 存储统一到 v2

### 唯一路径
`~/.dia/collab/inbox/<session_id>/<msg_id>.json`

`src/msg.ts`（v1，260 行）**整份删除**。

### 老数据一次性导入
```bash
dia msg migrate            # dry-run（默认）
dia msg migrate --apply    # 执行
```

- 从旧 agent 名（如 `session:ses_xxx`）提取 `ses_*`；提不到就报 `unresolved`，**不猜**
- 幂等：同 id 跳过，不覆盖已读/已回复
- 导入后**可 `show`、可 `reply`**（不是只读）

### 删掉的 v1 语义
| 命令 | 现在 |
|---|---|
| `msg send <agent名>` | `E_USAGE` + 格式提示 |
| `msg inbox <agent>` | 同上 |
| `msg ack/reply/close <agent> <id>` | 只接受 `<id>` |
| `msg delivered` / `needs-info` / `stuck` / `thread` / `agents` | 删除（`E_RETIRED`） |
| `dia in --legacy` | 删除 |

## 4. 分级日志

### 两个不同的东西，别混
| | `msg-events.ts`（事件流） | `log.ts`（运行日志） |
|---|---|---|
| 读者 | 机器（`trace`/`stats`） | 人 |
| 格式 | JSONL，**稳定 schema** | 文本，无 schema 承诺 |
| 内容 | 状态迁移的**事实** | 细节与业务快照 |
| 开关 | 无（审计必写） | `DIA_LOG_LEVEL` |
| 失败 | 静默 | 静默 |

### 级别
```
verbose < debug < info < warn < error     （显示 >= 阈值）
off                                        （全关）
```
- **默认 `verbose`**（开发主力机全开）
- 来源 `DIA_LOG_LEVEL`，大小写不敏感，非法值回落 `verbose`，`trace` 视为 `verbose`
- 走 **stderr**，不污染 `--json`
- 单条 < 4096B

### 留痕单一入口
业务代码不直接调 `events.log()`，走 `src/trace.ts`：

```ts
trace.fact({ event: "acked", msg_id, thread_id, actor, to_state, latency_ms });
trace.snapshot("send.begin", { id, from, to, body_bytes });
trace.detail("命中冷却", { rom_id, days });
```

硬约束：所有函数返回 `void`、不抛、无 `await`、**不改变业务分支**。

## 5. 对抗评审发现并修复的问题

| # | 问题 | 严重度 |
|---|---|---|
| 1 | `acp_cmd` 指向不存在的二进制 → 子进程崩溃、`inject.failed` 不写、`attempts` 恒 0 → **无限重投** | 🔴 |
| 2 | `dia out --to <人名>` 绕过 id 校验，静默创建假会话目录 | 🟡 |
| 3 | `msg-acp.ts` 使用未 import 的 `msg.*`，被 catch 吞掉 → 标题恒为占位符 | 🟡 |
| 4 | `SID_RE` 与 `SESSION_RE` 字符集不一 → `ses_abc.def` 被截断 | 🟢 |
| 5 | 自动 ACP 通道 `stdio:"ignore"`，verbose 日志全丢 | 🟢 |
| 6 | `close()` 先改 state 再读 `from_state` → 恒为 `closed` | 🟢 |

## 6. 合并到 v0.0.54 时新修的

- **`looksSession` 悬空**：v0.0.54 的 `msg send` 分派调用了不存在的函数（git 自动合并留下）
- **`routeMsgSend` 单目标 JSON 形状**：原为 `{addr, why, messages}`，改为单目标返回裸消息（与 `--to ses_x` 一致）
- **`dia out` 支持位置参数**：`dia out ses_x --subject …`（v0.0.54 只认 `--to`）

## 7. 未测

- **macOS 未测**（只在 WSL2 + opencode 2.2.6 上验证）
- 真实 tmux pane 注入未复测（只有 fake-tmux）
- dsh / 其他 ACP 实现**未接、未测**
- 并发 `msg migrate --apply` 无锁
- ACP 一轮成功 ≠ 模型真读到（`exposed_at` 仍需宿主回执）

## 8. 判据

```bash
bun run test                    # 795 pass / 0 fail
dia msg analyze-storage         # 存储体检
dia msg trace <id>              # 单条全链路
```

## 9. 踩过的坑（留给后来人）

1. **`git merge-tree` 报 0 冲突 ≠ 合并正确**。v0.0.54 的合并自动成功，但跑出 46 个失败（悬空引用、正则口径）。**合并后必须跑全量测试。**
2. **分支单独绿 ≠ 合并后绿**。`ses_acp_ok` 的正则不一致在 r3 单独跑时测不到（那条测试属于 acp 分支，只有合并才同时存在）。
3. **两个分支改同一批文件时，先看语义再看文本冲突**。`escalate` 与 `notify-acp` 插在同一位置，是位置重叠不是语义冲突；但 `events.log` → `trace.fact` 是真正的语义冲突，git 看不出来。
