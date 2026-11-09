# 固定席位 + 上下文亲和（M2 设计）

> 状态：M2a 已实现（2026-11-09）：`dia graph --next --seats N`｜`src/seats.ts`
> 未实现：handoff 自动建议、metrics 落盘、HTML 席位视图；依赖：`graph-prio-dag.md`、`graph-ui-m1.md`
> 红线：**只读建议；不写 tasks 账本、不常驻守护、不抢占、不自动 force 接管**。

## 1. 目标 / 非目标

**目标**：席位（并发会话）数量固定时，回答「每个席位现在接哪件」——同时考虑价值（rank）、约束（依赖/claim）与**断链成本**（上下文）。

**非目标**：自动领取/自动开工；跨机席位发现；任务级分布式锁；把 rank 变成门禁。

## 2. 名词与事实源

| 名词 | 定义 | 事实源 |
|---|---|---|
| seat | 一个在线会话（opencode/dsh 进程） | `~/.dia/collab/sessions/*.json` 的 `last_seen` |
| presence | `now - last_seen <= TTL`（默认 30m，`--presence-ttl`） | 同上 |
| claim | **路径**租约（谁在改哪个文件） | `~/.dia/collab/claims.jsonl`（TTL 默认 4h） |
| owner | 任务声明的负责人（不发租约） | `tasks/ledger.jsonl` 的 add/plan |
| busy | 席位有 `doing` 任务 | 任务 status |
| 亲和 | 任务与该席位近期工作面的重叠度 | 任务 touches + 席位最近任务 |

**分工写死**：`rank` 只回答「先做什么」；`claim` 只回答「谁能改哪条路径」；`owner` 只回答「谁负责」，三者不得互相替代。

## 3. 席位状态机（全派生，零写入）

```
        online & 无 doing            online & doing(todo/doing)
   ┌──────── idle ◄────────┐        ┌──────── busy
   │                       │        │
   │  (接新任务即 busy)     └────────┤
   └──────── holding ◄──────┘   doing 但 status∈{review,blocked}（释放执行位，保留上下文）
                 │
          last_seen 超 TTL
                 ▼
              offline（不再分配；其 doing 任务标 stale，需人确认）
```

- `holding` 仍可接新任务（执行位空闲），但提示「上下文占用 N 个」；N>3 建议先 handoff；
- `offline` 的 `doing` 任务**回候选集**但标 `reason:'seat_offline'`，不自动改 status/owner；
- 无自动回收路径：busy→idle 只在任务状态变化时派生，进程退出即 offline（靠 TTL）。

## 4. 亲和度（affinity）

```
aff(t, seat) = 3 * ownerMatch      # seat.session == t.owner
             + 2 * splitGroup      # 与席位最近任务共享 split_from 或同一父
             + 2 * jaccard         # touches 的 Jaccard，[0,1]，0/0 = 0
             + 1 * moduleOverlap   # 路径前 2 段前缀相同
cost(t, seat) = 1 - aff/8            # ∈ [0,1]，越小越省
```

- `seatTouches` = 该席位最近 H=5 个任务（doing/review/done）的 touches 并集；
- 分量量纲固定：owner/split/module 为 0/1，jaccard 归一化到 [0,1]；`aff` 最大 8；
- **算例**（必须进单测）：

| 场景 | aff | cost | 结论 |
|---|---|---|---|
| 同 owner（3） | 3 | 0.625 | 可接，但不算强亲和 |
| 同 split 组（2）+ jaccard 0.5（1） | 3 | 0.625 | 同上 |
| 同 owner + 同模块（4） | 4 | 0.5 | 达到「续做」阈值 |
| 完全同 touches（jaccard=1，2） | 2 | 0.75 | 单靠路径重叠不续做 |
| owner+split+jaccard1+module（8） | 8 | 0 | 强续做 |

> 阈值：**续做** `cost ≤ 0.5`；**换人** 当 `cost > 0.5` 且存在另一席位 `cost 低 ≥ 0.25`。单靠「路径重叠」不足以免换人——避免把不相关任务硬塞给同一席位。

## 5. 分配算法（rank 优先，亲和定席位）

```
候选 = startable ∧ rank≠null ∧ 无「路径 claim 冲突」
对候选按 rank 升序：
    在空闲/持有席位中，选 (cost, seat.id) 最小者
    若该席位 busy → 跳过（不抢占）
输出 assignments；未被分配的进入 unassigned，带原因
```

- 复杂度 `O(N·S)`（N 候选、S 席位），500×3 < 1ms；
- **presence 刷新**：执行 `--seats` 的会话会先 `whoami` 一次（任一 dia 命令都算在线）；无会话标识时跳过；
- 确定性 tiebreak：`(cost, declared prio index, task.id, seat.id)`；
- **不做**「全局最优分配」：席位小、账本变动频繁，贪心 + 可解释优先；
- 显式反例（写入文档，防止误读）：rank 1 但亲和极差的任务仍会被先分配——这是「价值优先」的代价；若需要「上下文优先」模式，M3 再加 `--by=affinity`。

## 6. CLI 契约

```bash
dia graph --next [n] --seats 2 --presence-ttl 30m --now 2026-11-06T10:00:00 --json
```

```json
{
  "schema": 1,
  "policy": "seats-v1",
  "seats": [{"seat":"ses_a","state":"idle","presence_at":"2026-11-06T09:58:12Z","focus":null}],
  "assignments": [{"seat":"ses_a","task":"t-3c1f","rank":1,"eff":"P0","cost":0.25,"affinity":{"owner":1,"split":0,"jaccard":1,"module":0},"why":"同 owner + 路径重叠 1.0"}],
  "unassigned": [{"task":"t-9","rank":4,"reason":"no_seat|seat_offline|claim_conflict"}],
  "conflicts": [{"task":"t-9","kind":"claim_overlap","detail":"src/x.ts 被 ses_b claim"}],
  "metrics": {"switches": 1, "handoff_rate": 0.0, "idle_slots": 0}
}
```

- **不含墙钟**：只出 `presence_at`（ISO）；`--now` 仅用于计算 state/交接判断，不落输出；
- 同一 `--now` + 同一账本 → 字节相等；打乱任务顺序结果不变；
- 退出码：0 正常（含无任务）、2 参数错、3 依赖环（排序不可用）。

## 7. 链式续做与 handoff

默认**续做**（cost ≤ 0.5 且席位非 busy）。**必须打断**的四条：
1. 出现更高 `rank` 且其它席位都接不住的任务（价值让位）；
2. 下一环 touches 与席位工作面**无重叠**（模块切换，cost > 0.5）；
3. 当前任务进入 review/blocked（执行位空出，可换手）；
4. 上下文将满（启发式：本会话完成任务数 ≥K 或已有 1 次 handoff 建议）。

handoff 内容固定五段：目标状态 / 已完成 / 未完成 / 触碰文件 / 下一步命令；通道用 `dia msg send --kind handoff`，交接后**人工重新 claim**，不自动转移。

## 8. 指标（只读派生）

- `switches`：同一任务换席位的次数；
- `handoff_rate`：有 handoff 消息的任务 / 被接手任务；
- `idle_slots`：在线但无任务的席位数；
- 采样窗口由调用方传 `--since`，不落账本；用于评估「固定席位是否够用」。

## 9. 边界

- **claim 与 presence 冲突**：claim 4h 有效但会话 30m 离线 → 标 `conflicts: claim_held_offline`，任务进 unassigned 且**不自动 force**（人工 `dia claim --force` 或等 TTL）；
- 席位掉线：`offline`，其任务回候选并标 stale；
- S > 任务数：多余席位 idle，不为填满降低门槛；
- S=0：纯建议模式，全量 unassigned，exit 0；
- 跨机：只读本机 `~/.dia`，其它机器会话视为离线；
- 空 touches：jaccard=0，不除零；
- 环内/终态任务不进候选。

## 10. 验收

- 打乱任务顺序、固定 `--now` 两次输出字节一致；
- busy 席位不被二次分配；holding 可接新任务；
- affinity 五个算例硬断言（含 0/0）；
- claim 冲突进 conflicts 且不抢占；
- `--seats 1` 与 `graph --next` 单项一致（同一排序源）；
- e2e：两会话（`DIA_SESSION_ID`）跑 `whoami` + doing → 各得一任务；杀一个会话超 TTL 后任务回落。
