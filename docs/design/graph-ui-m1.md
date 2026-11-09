# 关系图界面：派生量上屏（M1 UI）

> 状态：已实现（2026-11-09）｜实现：`src/graph-html/{render,template}`｜上游：`graph-prio-dag.md`
> 原则：**排序只在 TS 算一次**（`src/plan.ts`），前端只渲染；导出件仍无网络。

## 1. 目标 / 非目标

**目标**：把 `eff /ready/rank/critical/blocked/slice` 变成可读、可验证的视觉与交互；让「该不该提优先级、先做哪件」在图上直接确认。

**非目标**：不做席位分配（见 `seat-scheduling-m2.md`）；不做实时刷新（见 `graph-web-m2.md`）；不在前端重算排序。

## 2. 数据契约（导出 payload v1.1，additive）

| 字段 | 类型 | 说明 |
|---|---|---|
| `eff` | `P0`–`P?` | 有效优先级；`P?` = 未排期（内部 99） |
| `inherited` | bool | `eff` 严格高于声明值 |
| `prio_source` | `{id,declared,distance}` | 继承来源（min eff → min distance → min id） |
| `declared` | `P0`–`P?` | 声明优先级 |
| `rank` | int \| null | Kahn-v1 全局序号；终态/环内为 null |
| `rank_key` | `(string\|number)[]` | 8 元组 `[eff,due,critical,slice,-unblocks,depth,created_at,id]`，由 `plan.rankKey()` 生成 |
| `rank_reason` | string | 首个分胜负的键（如 `eff: P0 < P2`） |
| `critical` | bool | 非终态声明 P0/P1 的祖先（关键闭包） |
| `ready` / `startable` | bool | 结构就绪 / 可开工（todo 且 ready） |
| `blocked_by` / `released_by` / `dangling` | string[] | 未满足依赖 / dropped 释放 / 不存在的依赖 |
| `due_offset` / `created_offset` | int \| null | 相对 `today` 的天数（前端不做日期算术） |
| `unblocks` / `depth` | int | 传递下游数 / 最长依赖链 |
| `slice` / `split_from` / `split_children` | — | 拆分元数据（不是图边） |
| `next` | `{policy,n,items[]}` | 与 `dia graph --next n` 同源同序 |

`schema` 仍为 1；`capabilities` 追加 `eff-lane`、`next-panel`、`rank-factors`。
**白名单**：不导出 evidence/closure_reason/blocked_reason；`--redact` 时 owner → 短 hash、touches 只留文件名。

## 3. 泳道口径

- 默认 **按 `eff`** 分行；工具栏 `声明 / 有效` 切换，URL `pl=eff|declared`（非默认才写）；
- `laneOf(t) = pl==='declared' ? declared : eff`；泳道按 `prioIndex` 升序，`P?` 恒在最后；
- 切到「声明」时，被继承抬升的卡片显示 `↑P0`，让人看见「它其实更急」；
- **迁移说明**：默认从 declared 改 eff 属可见变更，导出件页头标注「泳道=有效优先级」，并更新既有截图基线。

## 4. 卡片徽标（多槽，不是单槽竞争）

| 槽 | 内容 | 规则 |
|---|---|---|
| 描边 | `critical` | 紫色描边（不与 P1 橙冲突）；环内任务改用红色虚线描边 |
| 角标 | `#rank` / `#—` | 常驻；终态 `#✓`；环内 `#⚠`；过滤视图标「全局」 |
| 徽标行 | `↑P0`、`🔒2`、`slice` | 最多 2 枚 + `+N` 溢出；`🔒n` = 未满足依赖数（dangling 计入，tooltip 标 missing） |
| 状态 | `⏸ 人工 blocked` | 与依赖阻塞分开：`status==='blocked'` 但 deps 全满足时只显示这个 |

`tooltip` 固定模板（可 DOM 断言）：
- `有效 P0 ← P0@t-3c1f（1 跳）· 声明 P3`
- `等 2 个前置：t-a(todo)、t-b(missing)`
- `解锁 3 个下游 · 关键闭包`

点击 `↑P0`：清空 `sel`、必要时切到「全部时间」、滚动居中并打开来源任务抽屉；来源被截断/时间窗隐藏时只 toast「来源不在当前视图」，不静默改视图。

## 5. 右侧「下一步」面板

- 与 `dia graph --next 5` **同源**（共用 `buildNext()`），顺序 `doing（rank 升序）→ startable（rank 升序）`；
- 每条显示 `#rank 标题 · eff · 理由（解锁 N / 关键闭包 / 继承来源）`；
- doing 超过 5 个 → 前 5 + 「另有 N 个进行中」；环内 doing 单列「异常」区；
- 空态：区分「账本为空」与「时间窗内无任务」（后者给「放宽到全部时间」）。

## 6. 任务抽屉「四问」

1. **优先级**：声明 / 有效 / 来源链（几跳、原始声明）；
2. **等谁**：`blocked_by` 明细（各自 status；missing 标红）；`released_by` 单独提示「前提已失效」；
3. **解锁谁**：直接 dependents 列表 + 传递计数 `unblocks`；
4. **为什么这个序**：`rank_key` 8 项逐项取值 + `rank_reason`（首个分胜负项）。

命令页保持只读（复制 `dia task plan/claim/msg`），不假装能发送。

## 7. 关键闭包（原“关键路径”）

- `critical` = 非终态声明 P0/P1 的**祖先闭包**（不是最长路，菱形会多分支）——文案统一写「关键闭包」，避免过度承诺；
- 节点：紫色描边；边：`depends_on && (from.critical || 声明 P0/P1)` 且 `to.critical`，描边同色；
- 与选中/阻塞叠加：描边只占一层，选中用外发光，阻塞用左侧锁条。

## 8. 截断与规模

| 可见卡片 | 行为 |
|---|---|
| ≤ 120 | 全功能（详细模式可用） |
| 121–200 | 强制简约；顶部黄条「已进入大图模式」 |
| 201–500 | 仅 `layout=dep` 且禁用「详细」；`--all` 才能突破 |
| > 500 | 拒绝渲染（exit 2），提示缩小时间窗或 `--limit` |

- 截断顺序：rank 非空升序 → 终态按 `closed_at` 降序保留前 20 → 声明优先级 → id；
- **deps 与 edges 一律按 `shownIds` 过滤**，卡片标 `deps_truncated`，避免「有依赖没卡片/没边」；
- `truncated={shown,total,hidden_ids≤20,policy:'rank-first'}`；`--limit N` 显式覆盖阈值但记录警告。

## 9. URL 与深链

`#/graph?layout=priority|dep&pl=eff|declared&w=7|14|30|0&sel=a,b&task=t-x&tab=task|intervene`
- 互斥：改 `w` 清 `from/to`；`layout=dep` 时 `pl` 保留但不生效；
- `go()`/`toggleSel()` 重建 hash 必须保留未知键（`pl`）；
- `from/to` 偏移以 payload 的 `today` 为基准（删除模板里 2026-11-06 常量）。

## 10. 验收

- DOM：继承卡片有 `↑P0` 且 tooltip 含来源 id/跳数；`pl=eff` 与 `pl=declared` 泳道标签不同；
- 一致性：`payload.next.items` 与 `dia graph --next 5 --json` 逐项相等；
- 抽屉：四问非空，`rank_key` 8 项；`blocked_by` 含 missing 标注；
- 降级：环 / 悬空 / 全终态 / 空账本 / 时间窗空 五态不抛错、各有文案；
- 确定性：同一 `--now` 两次导出字节一致；无 `fetch(`/外链；
- 截图 5 张：有效泳道、声明泳道、下一步面板、抽屉四问、时间线（关键闭包+开放端）。
