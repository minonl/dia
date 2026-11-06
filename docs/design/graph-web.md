# dia graph Web 视觉设计稿（v0.3）

> 静态 mockup：[`graph-web-mockup.html`](graph-web-mockup.html)（浏览器直接打开，无网络/无依赖）
> 数据契约：`dia graph --json`（schema 1）；时间线所需 start/end 为后续扩展字段。

## 1. 两个视图

顶部 tab：

- **关系图**：回答“谁依赖谁、先后顺序、优先级”；
- **时间线**：独立甘特图，回答“什么时候做、做到哪、是否延期”。

### 关系图：按依赖深度分层，不按状态分列

- 横轴 = 依赖深度（拓扑层），从左到右；
- 纵轴 = 层内排序；`依赖顺序` / `优先级` 可切换（P0 优先）；
- **状态不占布局**：用左边框颜色 + 进度条 + `status` 文本表达；
- `简约`：只显示 task + `depends_on`；
- `详细`：展开 owner、session、path、touches、claims，并在卡片里列具体关联（`depends_on / depended_by / touches / claims / collaborates_with`）。
- 图例固定在画布右下角：只显示当前模式会用到的边；`→` 单向、`↔` 双向，线型与图上一致。

### 时间线：独立甘特

- 每行一个 task，横轴为相对今天的天数（`-8d … today … +4d`）；
- 条长 = start/end，内部填充 = progress；
- 颜色 = status；橙色描边 = 关键路径；红色虚线 = 今天；
- 点击条/行可看任务详情。

## 2. 边语义

| 关系 | 方向 | 线型 | 颜色 |
|---|---|---|---|
| `depends_on` | 单向 `→` | 实线 | 蓝 |
| `touches` | 单向 `→` | 虚线 `6 4` | 紫 |
| `claims` | 单向 `→` | 点线 `2 3` | 青 |
| `collaborates_with` | 双向 `↔` | 点线 `1 3` + 双箭头 | 灰（视觉示例，未进 M1 契约） |

## 3. 为什么不再按状态列/行

状态列会把“关系”切碎，且 TODO/DONE、REVIEW/BLOCKED 混在一列没有语义。现在：

- 依赖顺序是主结构（拓扑层）；
- 状态是属性（颜色/进度）；
- 优先级是排序维度（P0/P1/P2 + 层内排序）；
- 时间放在独立时间线，不挤在关系图里。

## 4. 与数据契约的映射

| UI | 数据 |
|---|---|
| task 卡片 | `nodes[kind=task]` + status/owner |
| 依赖边 | `edges[kind=depends_on]` |
| touches / claims | `edges` 对应 kind |
| 进度 | 后续 `task.progress`（0-100） |
| 时间线 | 后续 `task.start/end`（相对/ISO） |
| 关键路径 | 后续由依赖图最长路径计算 |

## 5. 实现约束

`tests/static.test.ts` 禁止框架 import `node:http` / `fetch` / 网络模块。因此：

1. 本稿是静态 HTML，不进入 `src/`；
2. 真实实现优先 `dia graph --export-html` 生成静态文件；
3. live Web 需独立可选包 + 单独评审（loopback only）。

## 6. 后续

- 先确认“依赖深度分层 + 简约/详细 + 时间线”结构；
- 确认后做 `--export-html`（零网络），再评估 live 轮询。

## 7. URL 路由

静态稿支持 hash 路由（`file://` 直接可用）：

```
#/graph
#/graph?mode=simple
#/graph?mode=detail&sort=prio
#/timeline
```

- `view` 也可用 query 形式：`?view=timeline&mode=detail`；
- 切换 tab / 简约详细 / 排序会同步更新 hash，便于分享/回链；
- 真正的独立 path（`/graph`、`/timeline`）需要部署层 rewrite 到同一 HTML，或导出时生成
  `graph.html` / `timeline.html`；静态文件本身不能凭空提供两个 path。
