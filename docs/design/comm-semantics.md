# 跨会话通信：语义、排序与指标（M1）

> 状态：M1 已实现（2026-11-06 ~ 11-09）｜代码：`src/collab.ts`、`src/msg-priority.ts`、`dia collab stats`
> 后续：观察器/唤醒见 §7（M3，未实现）；席位见 `seat-scheduling-m2.md`

## 1. 三个事实

1. **投递 ≠ 处理**：消息是文件邮箱，对端只在下次 turn 跑 `dia in` 才看见；
2. **不能靠“催”解决**：真正需要的是「可观测 + 可唤醒」，不是 deadline；
3. **优先级不能自称**：发送者不能设 `--priority`，只能从**任务账本的 eff** 派生，并**到达时快照**。

## 2. 送达三态

```
pending ──dia in 成功输出──▶ delivered ──hook/--expose──▶ exposed ──ack──▶ acked
   │                              │                          │
   └──────── 直接 ack/reply/close：补写 delivered_at + first_touch_at ─────┘
```

| 态 | 写入者 | 含义 | 指标用途 |
|---|---|---|---|
| `delivered_at` | `dia in`（**输出成功后**） | 被读过（含 `--expose`） | `delivered_rate` / `deliver_lag` |
| `exposed_at` | 宿主 hook / `dia in --expose` | 已注入模型上下文 | `exposed_rate`（**主口径**） |
| `acked_at` | `dia ack` | 已显式处理 | `ack_rate`（仅 requires_reply/handoff） |

- `first_touch_at`：ack/reply/close 跳过 `in` 时补写，避免 `delivered_at` 缺失；
- `dia in` 先输出再批量落 delivered（EPIPE/截断不算送达）；批量写用一次锁 + 一次读（修掉 O(N²)）。

## 3. 优先级（全派生，不开放自定义）

```
base = 发送者「doing 任务」的最高 eff（无 doing → 2）
adj  = requires_reply -1 | handoff -1 | notify +1 | deadline≤15m -1 | hops≥2 +1
cls  = clamp(base+adj, 0..3)
caps = notify ≤ P2；reply ≤ P1；hops ≥3 → P3
```

- **到达时快照**写入 `class_snapshot/class_why`：任务改 prio 不会回溯改写历史消息；
- 发送者无任务/离线 → base=2（不冒充紧急）；`deadline` 过期不参与抬升；
- `dia out` **没有 `--priority`**；想提高优先级 → 先改任务 prio（可审计）。

## 4. 排序

- `dia in` 默认 `--sort priority`：`(class 升序, created_at epoch 升序, id 升序)`；类内严格 FIFO，不插队；
- `--sort arrival` 回到纯到达序（兼容/排障）；
- 历史消息按 `Date.parse` 取 epoch（`+08:00` 不再字典序排错），无法解析的落末尾；
- 防饿死：`--limit` 时保留 1 个名额给最老的非终态消息（后续实现 aging）。

## 5. 指标（`dia collab stats`）

```bash
dia collab stats [--since 7d] [--by session|pair|class] [--now ISO] [--json]
```

- **cohort 口径**：按 `created_at` 入窗，比率共用同一分母；
- 排除：legacy、自环、`closure_reason=duplicate`；
- `delivered_rate` / `exposed_rate` / `ack_rate` / `reply_rate`（requires_reply 消息级）；
- `deliver_lag` / `reply_latency`：median + p90 + n + `censored`（未回复样本）；
- **backlog 单独口径**：当前非终态（跨窗口），含 `oldest_age`、`orphan`（收件人从未注册）、`by_class`；
- 默认不含正文/owner/路径；后续加 `--verbose`。

## 6. 锁与顺序健壮性

- 锁文件带 `{pid, token}`：进程活着**永不**判陈旧；进程死了**立即**回收；释放只删自己的 token；
- 历史消息缺 `arrival_seq` 时按 `created_at` epoch + `id` 稳定排序（不引入全局计数器热点）。

## 7. 观察器与唤醒

- **指标不需要常驻**：读时聚合即可；
- **观察器用法（M3a）**：`dia collab observe` 恒为**一次性 tick**（无 `--watch/--daemon`，请求即 `E_NO_DAEMON`）；
  定时交给唯一调度器 `dia job`，推荐 **300s**（与插件 5 分钟节流同量级；cron 需 60 的倍数）：

  ```bash
  dia job install collab-observe --desc 'collab board 刷新' --interval 300 --cmd 'dia collab observe'
  ```

  `dia collab enable` 会**幂等**注册这条 job（已存在则跳过；job 门控判 class=unknown 时按
  `--allow-unstable` 重试一次）；注册失败只告警，不阻塞消息能力。

- 产出 `collab/state/board.json`（0600、原子写）/ `metrics/<day>.json` / `escalations.jsonl`
  （去重：同一 `id:class` 只追加一次；只含 id/class/age，无正文）；
- `dia collab board` 默认**只读**：缓存新鲜直接用；缺失/过期时**内存现算**（`stale:true`），不写盘；
  `--refresh` 才落盘，`--cached` 只看缓存（缺失 exit 3，可与「0 未读」区分）；
- 新鲜度：`TTL = 2×interval`，且必须 `> interval+60s`（上限 900s）；**interval 只认 board 里的声明值**，
  回退计算不会用 CLI 默认值覆盖；未来时间戳视为不可信；
- `dia doctor` 增 `collab.observer` 检查：未注册定时 / board 未生成 / board 与 job 的 interval 不一致 /
  board 或 state 权限过宽 / board 超过 TTL 未刷新（均为 warn，不判红）；
- **M3b 已提供**：OpenCode 插件 `dia-inbox`（`ctx.session.hook("context")`）只读 board，
  每轮最多注入一行计数提示（新鲜 5 分钟节流 / 过期 1 小时并标注「可能不准」），
  **不调 `dia in`、不标 delivered/exposed、不写盘**；dsh 无 hook 时退化为 SKILL 规则；
## 8. 验收

- 三态：`in` 输出后 delivered；`--expose` 写 exposed；ack 直跳补 delivered/first_touch；
- 优先级：doing P0 → 消息 P0；无任务 → P2；notify ≤P2；hops≥3 → P3；
- 排序：class 升序 + 类内 FIFO；`--sort arrival` 兼容；
- 指标：固定 `--now` 的 fixture 断言 delivered/exposed/ack/reply 率、median、censored、orphan；
- 锁：死进程锁立即回收；坏 inbox 目录不阻塞全局扫描。
