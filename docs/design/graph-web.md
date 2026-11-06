# dia graph Web 视觉设计稿（v0.1）

> 静态 mockup：[`graph-web-mockup.html`](graph-web-mockup.html)（直接用浏览器打开，无网络/无依赖）
> 数据契约：`dia graph --json`（schema 1）；本稿只做视觉与信息层级，不是实现。

## 1. 布局

```
┌ header: dia graph · 只读 · 更新时间 ──────────────────────────┐
├ 工具栏：状态过滤 | 密度 | 提示                               │
├ 主画布（卡片 + SVG 边）                    ┌ 右侧 320px ────┐
│  sessions | todo | doing | review | paths │ 概览 / 需要人   │
│                                           │ 图例 / 节点详情 │
└ footer: 数据来源 / 约束 ───────────────────┴────────────────┘
```

- 主画布按状态分列：session → todo → doing → review → path；边的方向从左到右。
- 右侧固定 320px：概览计数、attention（阻塞/claim/待评审）、图例、节点详情。
- 节点卡片颜色只表达 **kind + status**，不用于装饰。

## 2. 信息层级

| 层 | 内容 | 设计 |
|---|---|---|
| 第一层 | task 标题 + status | 加粗 13px；状态色只出现在左边框和 badge |
| 第二层 | task id / owner | 11px muted；owner 显示短 id（`@a1b2c3d4`） |
| 第三层 | 依赖/触碰/claim | SVG 边 + 右侧详情；不在卡片里堆文字 |
| attention | 阻塞 / claim 冲突 / 待评审 | 右上角固定区，不藏在 hover 里 |

## 3. 交互

- 点击节点 → 右侧详情：kind/status/owner + 关联边列表；
- 顶部过滤：all / doing / blocked / review（客户端过滤，不改数据）；
- 密度切换：comfortable / compact；
- 刷新：MVP 静态导出；live 版用 `dia graph --json` 轮询（2s），不做 WebSocket；
- 不做：编辑、拖拽改依赖、写 claim（只读）。

## 4. 与现有数据契约的映射

| UI | `dia graph --json` |
|---|---|
| 卡片 | `nodes[]`：task/session/path |
| 依赖边 | `edges[kind=depends_on]` |
| 触碰边 | `edges[kind=touches]` |
| claim 边 | `edges[kind=claims]` |
| 阻塞提示 | task 节点 `blocked_by[]`（派生，不是边） |
| 环 | `cycles[]`，顶部红条提示 |

## 5. 实现约束（重要）

仓库的 `tests/static.test.ts` 禁止框架 import `node:http` / `fetch` / 网络模块。因此：

1. **本稿只是静态 HTML**，不进入 `src/`，不启服务；
2. 若将来要做真实 Web：
   - 方案 A：`dia graph --export-html` 生成静态文件（推荐，不需要网络）；
   - 方案 B：独立可选包 `@dia/graph-web`（明确例外 + 只绑 loopback + 单独评审），不改核心框架规则。

## 6. 后续

- 先确认视觉稿的列布局/信息密度/右侧 attention 位置；
- 确认后先做 `--export-html` 静态导出（零网络、零 daemon），再评估 live 轮询。
