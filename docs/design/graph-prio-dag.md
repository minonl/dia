# 优先级 × 依赖：任务编排语义（M1）

> 状态：已实现（2026-11-06）｜代码：`src/plan.ts`（派生纯函数）、`src/task.ts`（split）、`src/graph.ts`（契约）
> 相关：`graph-web-m1.md`（导出）、`msg-collab-m1-design.md`（任务账本）

## 1. 三个概念，别混

| 概念 | 回答 | 谁定 | 可否违反 |
|---|---|---|---|
| `prio`（声明优先级） | 这件事本身多重要 | 人 | 可随时改（`plan` 事件留痕） |
| `deps`（依赖） | 谁必须先完成 | 事实/拆分结果 | **不可违反**（硬约束） |
| `rank`（执行顺序） | 现在先做哪件 | 由前两者派生 | 建议，不写账本 |

结论：**被依赖 ≠ 优先级更高；优先级高 ≠ 先执行**。高优先级任务被卡住时，上游会获得「有效优先级」，否则 P0 永远开不了工。

## 2. 有效优先级（eff）

```mermaid
flowchart LR
  C["C: P0（声明）"] --> B["B: P2（声明）"]
  B --> A["A: P3（声明）"]
  C -. "eff P0 传播" .-> B
  C -. "eff P0 传播（2 跳）" .-> A
```

- 只从**声明 P0/P1** 的非终态任务向**全部祖先**传播；
- **不衰减、不累加**（fan-in 取最小/最高；跳数只展示，不参与计算）；
- 终态（done/accepted/dropped/rejected）下游不产生传播；
- 输出 `eff_prio` + `prio_inherited` + `prio_source{id,declared,distance}`，声明值不变。

## 3. 就绪与排序

- `satisfied = done | accepted | dropped`（`dropped` 释放下游，但产出 `released_by` 提示「前提失效」）；
- `ready` = 非终态、不在环里、所有 deps 已 satisfied 且无 dangling；
- `startable` = `ready && status === "todo"`（`doing` 是已开工，`blocked` 是停着，都不进 `--next` 候选）；
- `rank`：**Kahn + 优先队列**（不是先分层再排），key 升序：
  `eff → due（无 due 排末尾）→ critical → slice → -unblocks → depth → created_at → id`；
- 终态与环内任务 `rank = null`；`--next` 默认取前 5，doing 置顶；
- **rank 不含「今天」**，保证 `graph --json` 两次运行字节相等；到期紧迫度只在导出时展示。

## 4. 关键路径与拆分

- `critical` = 非终态声明 P0/P1 的所有祖先（图里橙色高亮）；
- `split`：父 depends on 子（父 = 集成收口），**单条原子 `split` 事件**落账；
  - 子继承父 `judge`（`judge_inherited`），否则 done 门禁会卡死每个切片；
  - `slice` 标记最小可用切片，仅做同级 tiebreak；
  - 组成关系只做元数据（`split_from/split_children`），**绝不作为图边**参与环/排序；
  - 子任务的 eff 由父的声明优先级自然传播得到，不复制 prio（避免 P0 灌水）。

## 5. 检查（advisory，exit 0；有环 exit 3）

| kind | 含义 | 处置 |
|---|---|---|
| `dangling_dep` | 依赖的 id 不存在 | 补 `link` 或删依赖；不视为就绪 |
| `released_by_drop` | 依赖已 dropped | 确认下游是否还需要做 |
| `long_chain` | 声明 P0/P1 的依赖链 ≥3 跳 | 提示拆分（真正的拆分触发点） |
| `cycle` | 依赖环 | 必须修（exit 3） |

## 6. 命令

```bash
dia task split <id> --into "最小可用,完整实现" [--slice 最小可用] [--force]
dia graph --next [n] [--json]        # 按 rank 的开工建议（doing 置顶）
dia graph --explain <id> [--json]    # 声明/有效/来源/被谁卡/解锁谁/rank
dia graph --lint [--json]            # 编排检查（advisory）
```

`graph --json` 新增节点字段：`eff_prio` / `prio_inherited` / `prio_source` / `critical` / `ready` /
`startable` / `released_by` / `dangling_deps` / `depth` / `unblocks` / `rank` / `split_from` /
`split_children` / `slice`；顶层 `ranking.policy = "kahn-v1"`，`capabilities` 追加 `eff-prio/ready/rank/split`。

## 7. 边界

- **席位（并发数）不在本模型里**：rank 是单席位理想序；多席位 + 上下文亲和（touches 重叠、同 split 组）留 M2；
- `claim` 仍是唯一并发信号；eff/rank 只回答「先做什么」，不回答「谁能做」；
- 派生量全部只读，不写回账本，不进任何门禁。

## 8. 反例（自测覆盖）

- 链式：A(P3)←B(P2)←C(P0) → A/B eff P0，rank A<B<C；
- 终态：C 已完成 → 不传播，B 保持 P2；
- fan-in：一个 P3 被两个 P1 依赖 → eff P1；
- 悬空：依赖不存在 → not ready + lint；
- 环：rank null，`--next/--lint` exit 3；
- P10 vs P2：数字比较（`P2` 在前），无 prio 视为 `P99`。
