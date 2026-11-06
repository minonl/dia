# dia graph Web 视觉设计稿（v0.2）

> 静态 mockup：[`graph-web-mockup.html`](graph-web-mockup.html)（直接用浏览器打开，无网络/无依赖）
> 数据契约：`dia graph --json`（schema 1）；本稿只做视觉与信息层级，不是实现。

## 1. 布局

```
┌ header: dia graph · 只读 · 更新时间 ──────────────────────────┐
├ 工具栏：状态过滤 | 密度 | 提示                               │
├ 主画布（卡片 + SVG 边 + 右下角图例）       ┌ 右侧 320px ────┐
│  sessions / todo / doing / review / blocked / done / accepted / paths │ 概览 / 需要人 │
│                                           │ 节点详情        │
└ footer: 数据来源 / 约束 ───────────────────┴────────────────┘
```

- 主画布按状态**分行**：sessions → todo → doing → review → blocked → done → accepted → paths；**每个状态独立一行，不做合并**；边的方向自上而下（同层可横向）。
- 图例不再单独占侧栏，放在画布**右下角**，随画布滚动可见。
- 右侧固定 320px：概览计数、attention（阻塞/claim/待评审）、节点详情。
- 节点卡片颜色只表达 **kind + status**，不用于装饰。

## 2. 信息层级

| 层 | 内容 | 设计 |
|---|---|---|
| 第一层 | task 标题 + status | 加粗 13px；状态色只出现在左边框和 badge |
| 第二层 | task id / owner | 11px muted；owner 显示短 id（`@a1b2c3d4`） |
| 第三层 | 依赖/触碰/claim | SVG 边 + 右侧详情；不在卡片里堆文字 |
| attention | 阻塞 / claim 冲突 / 待评审 | 右侧固定区，不藏在 hover 里 |

## 3. 边语义（方向 + 线型必须一一对应）

| 关系 | 方向 | 线型 | 颜色 | 说明 |
|---|---|---|---|---|
| `depends_on` | 单向 `→` | 实线 | 蓝 | 被依赖方在箭头指向的一端 |
| `touches` | 单向 `→` | 虚线 `6 4` | 紫 | task 触碰 path |
| `claims` | 单向 `→` | 点线 `2 3` | 青 | session 声明 path |
| `collaborates_with` | 双向 `↔` | 点线 `1 3` + 双箭头 | 灰 | 示例（当前 M1 数据契约未包含） |

- 所有单向边用**终点箭头**；双向边用**两端箭头**。
- 图例与图上边共用同一套颜色/虚线/箭头，避免“图例是图例、图上是另一套”。

## 4. 交互

- 点击节点 → 右侧详情：kind/status/owner + 关联边列表；
- 顶部过滤：all / doing / blocked / review；**过滤时节点和边一起重绘**（不留下指向隐藏节点的线）；
- 密度切换：comfortable / compact；
- 刷新：MVP 静态导出；live 版用 `dia graph --json` 轮询（2s），不做 WebSocket；
- 不做：编辑、拖拽改依赖、写 claim（只读）。

## 5. 与现有数据契约的映射

| UI | `dia graph --json` |
|---|---|
| 卡片 | `nodes[]`：task/session/path |
| 依赖边 | `edges[kind=depends_on]` |
| 触碰边 | `edges[kind=touches]` |
| claim 边 | `edges[kind=claims]` |
| 阻塞提示 | task 节点 `blocked_by[]`（派生，不是边） |
| 环 | `cycles[]`，顶部红条提示 |

> `collaborates_with` 是视觉稿里的双向示例，尚未进入 M1 数据契约，不应当作已实现。

## 5. 实现约束（重要）

仓库的 `tests/static.test.ts` 禁止框架 import `node:http` / `fetch` / 网络模块。因此：

1. **本稿只是静态 HTML**，不进入 `src/`，不启服务；
2. 若将来要做真实 Web：
   - 方案 A：`dia graph --export-html` 生成静态文件（推荐，不需要网络）；
   - 方案 B：独立可选包 `@dia/graph-web`（明确例外 + 只绑 loopback + 单独评审），不改核心框架规则。

## 6. 后续

- 先确认视觉稿的列布局/信息密度/右侧 attention 位置；
- 确认后先做 `--export-html` 静态导出（零网络、零 daemon），再评估 live 轮询。
