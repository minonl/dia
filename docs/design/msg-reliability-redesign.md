# dia msg 重新设计：从「能发」到「可证送达、可复盘」

> 日期：2026-11-10 ｜ 状态：**P0–P3 已实现**（dsh 插件：包 + 安装器 + dump-config 校验；真机 dsh 启动未实跑） ｜ 触发：用户实测「对方在处理完等我回复时，完全没收到我们消息的迹象」；团队三角色复核（现状口径 / 传输层 / 指标与测试）

## 0. 先把事实对齐

| 用户的观察 | 结论 |
|---|---|
| 「原来的 tmux 也不催促，会进入消息队列，不是插队」 | 对。`paste-buffer` 只是把文本放进输入缓冲，agent 下一轮才处理；不是打断 |
| 「看不到 `dia out` 的消息进入对方队列」 | 对，而且比想象更彻底：**v2 的 `dia out` 只写文件**（`transport` 硬编码 `"file"`），没有任何 push 调用 |
| 「`dia in` 不如 tmux，显然」 | 对，但原因不是 push 更强，而是 **`dia in` 没有消费者**。用户手动发 tmux 时，**人**就是那个重试者 |
| 「10 分钟的定义要重查」 | 对。唯一的 10 分钟是 **board TTL = 2×interval = 600s**，语义只是「快照还能信多久」，跟「消息多久送达」无关 |

**今天的实测数据**（`dia collab stats --since 7d`）：

```
cohort=5  delivered=0.2  exposed=0  ack=0  reply=0.25
deliver_lag median=14.6h
backlog=4（oldest 3.7d，orphan=2）
```

也就是说：**80% 的消息从未被 `dia in` 读过，0 条被证明进了模型上下文。**

## 1. 现状盘点（团队核对）

| 项 | 现状 | 问题 |
|---|---|---|
| 事实源 | v2 `~/.dia/collab/inbox/<session>` + 每消息一 JSON | ✅ 结构可用 |
| 收件人 | v2 用 `ses_*`；v1 用 agent 名 | 两套身份，pane 只存在 v1 agents 表里，**v2 无 session→pane 映射** |
| 投递 | v1 有 `tmux`/`acp` 通道（手动 `dia msg deliver`）；v2 只有 `"file"` | v2 **不会 push** |
| 收据 | `created_at`（发送方时钟）、`delivered_at`（接收方 CLI 打印）、`exposed_at`（只有 `--expose`） | `first_touch_at` 与 delivered 同刻写死；`exposed` 全仓无人写 |
| 事件流 | 无 | 投递失败只 throw，磁盘无痕；无法复盘「为什么没收到」 |
| 指标 | `stats` 只算最终时间戳 | 通道成功率（attempt 分母）**不存在** |
| 测试 | tmux 用例 0；ACP 只有 mock；无「双会话互发并被看到」e2e | 未测路径就是默认路径 |
| 命令面 | `dia in/out/ack/...` 与 `dia msg inbox/send/...` 两套 | 用户要记两套；agent skill 只教了一套 |

## 2. 目标架构：一个事实源，三层收据，push 只负责叫醒

```
发送方 ──L0/L1──▶ 邮箱（唯一事实源，append-only 事件 + 快照）
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   tmux 注入      ACP 回合      无通道（mailbox-only）
        │            │             │
        └──── L2 传输回执 ─────────┘
                     ▼
            接收会话（hook / 开工检查）
                     ▼  L3 context.exposed（真进上下文）
              agent 处理 → ack → reply/close（L4/L5）
```

**硬规则**

1. **通道成功 ≠ 已读**：`inject.verified` 只能到 `injected`；`delivered/exposed` 只能由消费侧证据写
2. **只有「负证据」才自动重试**（明确什么都没出现）；沉默/不确定 = `uncertain`，升级而不是重投
3. **push 只推指针（id + subject 单行）**，正文永远由 `dia msg show` 拉；subject 必须单行化（禁 `\n`/`\x1b`）
4. **push 只写 `injected`，不写 `acked`**；终态只能由接收方动作写
5. **没有 pane 不是错误**：`notified: mailbox-only` 是合法结果，但必须在 `dia msg send` 输出里显式打印

### 2.1 收据事件（append-only）

`~/.dia/collab/events/<YYYY-MM>.jsonl`，一行一事件，与消息快照并存（不引 DB）：

| 事件 | 关键字段 | 证明什么 |
|---|---|---|
| `send.accepted` / `send.failed` | message_id, idempotency_key=`thread#seq`, code | 落盘成功/失败（成功率分母） |
| `inject.attempted` / `.failed` | attempt_id, transport, endpoint_fp(pane+pid_start+cwd), error_code | 尝试过 |
| `inject.verified` | pane_id, cwd, attempt_nonce, captured_at | 文本进了终端缓冲（≠模型读过） |
| `read.observed` | by=`dia in` pid | 接收方 CLI 真的输出过 |
| `context.exposed` | by=hook turn_id / `--expose` | 进了模型上下文（**最强收据**） |
| `acked` / `replied` / `closed` | actor, body_hash | 人/agent 自述（唯一权威的「已处理」） |
| `inbox.checked` | actor, latency_ms=本次条数 | 本机跑过收件箱（doctor 用它区分「没人开工」） |
| `deliver.uncertain` | reason, last_known | 状态未知本身是事实 |

### 2.2 状态机

```
pending → injected → exposed → acked → replied → closed
             └── uncertain（禁止自动重试，人工 confirm）
             └── escalated（超时，只发指针，不重发正文）
```

## 3. 超时与 fallback（默认值 + env）

| 层 | 成功判据 | 超时 | 失败 fallback |
|---|---|---|---|
| 落盘 | rename 成功 + `thread#seq` 唯一 | 2s | 报错给发送方（幂等键可安全重试） |
| tmux 注入 | capture-pane 命中 `id + attempt_nonce`，且 pane/cwd/pid 匹配 | 5s | `E_BUSY` → 退避重排（60s 起 ×2，封顶 600s，≤3 次）；未验证 → `uncertain` |
| ACP 回合 | prompt 返回 **且** 对端有 ack/reply | 180s | 降级 mailbox-only + escalate |
| 接收开工 | 产出 `read.observed`/`context.exposed` | 已注入未读 TTL：P0/P1 15min、P2/P3 60min | 只提示，不重注正文 |
| requires_reply ack | `acked_at` | 30min（deadline 更早则用 deadline） | escalate 发送方 + 人 |
| 邮箱软 TTL | 4h 未送达 → escalate；30d 归档 | — | `msg-upkeep` 定时（300s）执行 |

每一项都可通过 `DIA_*_TIMEOUT_MS` / `DIA_MSG_ACK_TTL_MS` 覆盖，时钟可注入（单测断言用）。

## 4. 指标（分母写死，避免自欺）

cohort = 窗口内 created 且 `from != to`、非 `closed/duplicate`；未终结按**右删失**统计（进 rate 分母、不进 latency 分母，单列 `censored`）。

| 指标 | 定义 |
|---|---|
| `send_success_rate` | `send.accepted` / (`send.accepted` + `send.failed`) |
| `inject_rate` | `inject.verified` / `inject.attempted`（通道成功率，**与业务分开**） |
| `deliver_rate` / `expose_rate` | 有 `delivered_at` / `exposed_at` 占 cohort |
| `ack_rate` / `reply_rate` | 有 `acked_at` / `replied_at`（分母分别是 ackTarget / replyTarget） |
| `queue_lag` | `delivered_at - created_at`（在邮箱躺多久） |
| `start_lag` | `acked_at - delivered_at`（**被对方开始处理**） |
| `reply_latency` | `replied_at - acked_at` 与端到端 `replied_at - created_at`（median/p90 + censored） |

`dia msg trace <id>`：一条命令打出全链路时间线（含失败 attempt 与 error_code）。

## 5. 命令面收口

```
dia msg send <handle> [--requires-reply] [--kind K]
dia msg inbox [--unread] [--json]
dia msg show <id> [--json]
dia msg ack|reply|close <id> [...]
dia msg seen <id>            # exposed（给 hook 用）
dia msg trace <id>           # 复盘
dia msg stats [--since 7d]
dia msg deliver <handle> <id> [--transport tmux|acp]   # 显式重投
```

- 顶层 `dia in/out/ack/reply/close/show/whoami` **保留为别名**（SKILL/AGENTS 已写死），但 help 隐藏
- `dia collab` 只留运维面（`status/enable/disable/board/observe`），收发命令迁 `dia msg`
- agent 最小集只有 5+1 条（inbox → show → ack → reply → send，收档 close）
- 收件人统一 `--to <handle>`：`ses_*` → session；agent 名 → 绑定 session；多命中 `E_AMBIGUOUS`（不猜不广播）

## 6. 测试（补上「未测的默认路径」）

用 `tests/fixtures/fake-tmux.sh` 注入 PATH（`FAKE_TMUX_SCENARIO=idle|busy|no-readback|pane-mismatch|slow`），零代码改动即可测；ACP 用现有 `mock-acp.mjs` 加 `MODE=fail|hang`。

| 用例 | 断言 |
|---|---|
| mailbox-only 全链路 | send→in→ack→reply 全 0；`stats` 各 rate=1；`reply_latency ≥ start_lag ≥ queue_lag > 0` |
| tmux 忙 | `E_BUSY`；消息仍 pending；`send-keys` 调用 **0 次**；events 有 attempt |
| 回读失败 | `E_INJECT_UNVERIFIED`；**不写 delivered**；重投成功后 `delivered_at` 只写一次 |
| pane 复用 | cwd/pid 不匹配 → `E_PANE_MISMATCH`，`load-buffer` 0 次 |
| ACP 失败 + 超时升级 | `E_ACP` 事件；deadline 后 `escalated`；`reply_rate=0, censored=1` |
| 多会话同名 | 按 session 分投；`--to ops` → `E_AMBIGUOUS` |

## 7. 分期（先证据，再推送，再升级）

| 期 | 内容 | 风险 |
|---|---|---|
| **P0** | 事件流 `events.jsonl` + `dia msg trace` + `stats` 加 attempt 分母 + fake-tmux e2e + 修 `escalated` 不在 TERMINAL、`in` 先输出后落盘两个语义坑 | 低（不改消息路径） |
| **P1** | session→pane 绑定（注册采集 `TMUX_PANE`+pid+start+cwd，带 TTL 心跳）；`dia msg send` best-effort 注入一次（5s 超时，失败不阻断，打印 `notified: tmux|mailbox-only(reason)`） | 中（误投/重复注入，必须有指纹与幂等） |
| **P2** | 退避重投（job 300s 扫 pending，≤3 次）+ escalate 接线 + `context.exposed`（hook/`seen`） | 中 |
| **P3** | webhook transport（`DIA_MSG_WEBHOOK_URL`）+ 本地服务端实测；dsh 插件 + 安装器（`--dump-config` 校验；注入逻辑单测；真机 dsh 会话因缺 API key 未跑） | 中 |

## 8. 不做的

- 不把 push 变成第二事实源；不改「收件方 pull 也能读到」的语义
- 不引入常驻 daemon（沿用 `dia job` 唯一调度器）
- 不自动迁移 v1 邮箱（`legacy:true` 只读；显式 `dia msg migrate --map` 才搬）

## 9. 判据

```bash
bun test tests                      # 含 fake-tmux 6 个 e2e
dia msg stats --since 7d            # 同时输出 inject_rate 与业务 rate
dia msg trace <id>                  # sent→injected→exposed→acked→replied 时间线
dia msg send --to ses_xxx ...       # 输出 notified: tmux|mailbox-only(reason)
```
