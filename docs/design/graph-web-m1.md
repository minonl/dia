# dia graph Web（M1）设计：真实数据 → 单文件静态导出

> 状态：M1 设计（2026-11-06）｜前置：`graph-web.md`（视觉稿 v0.3）、`graph-web-mockup.html`（交互原型）
> 交付形态拍板：**先 A 后 B** —— M1 只做 `dia graph --export-html`；M2 再做 loopback 实时服务（独立包 + 独立评审）。

## 1. 目标 / 非目标

**目标**

- `dia graph --export-html [path]` 把真实账本渲染成**单文件 HTML**（CSS/JS/数据全内联），`file://` 打开即用；
- 视觉与交互沿用 mockup：优先级泳道 / 依赖视图、时间线、搜索 token、邻域聚焦、任务抽屉；
- 数据缺口显式降级，不伪造：缺字段有兜底并标注；
- 全程无网络：无端口、无外链、无 `fetch`。

**非目标（M1 不做）**

- 实时刷新、介入消息真正发送（M2 live 服务）；
- 服务端过滤/鉴权、多人共享；
- 把 mockup 的演示数据（t-3/t-4、claims=3、live data）带进导出件。

## 2. 流水线

```mermaid
flowchart LR
  L[账本 ledger.jsonl] --> F[task.fold<br/>add/link/plan/status]
  F --> T[Task[]<br/>prio/start/due/progress/closed_at]
  T --> G[graph.build<br/>schema 1 + capabilities]
  G --> R[graph-html.render<br/>白名单 + JSON 转义]
  R --> H[单文件 HTML<br/>file:// 打开]
```

- 模板以 **TS 字符串常量**进 `src/graph-html/template.ts`，被 `bun build` 打进 `dist/cli.js`（`install.sh` 只拷 `dist`，不得运行时读文件）；
- 渲染函数 `src/graph-html/render.ts` 纯函数：`render(graph, {now, redact}) -> string`，无 IO、无时钟（时间由调用方注入）。

## 3. 数据模型（Task 扩展）

| 字段 | 类型 | 语义 | 缺失时 |
|---|---|---|---|
| `prio` | `P0`–`P9` | 计划优先级（与 status 正交） | 归入 `P?` 末行泳道 |
| `start` | `YYYY-MM-DD` | **计划**开始（本地日） | 回填 `created_at` 的本地日，卡片标「按创建」 |
| `due` | `YYYY-MM-DD` | **计划**结束/截止 | 未完成 → 时间线画开放端；已完成 → 用 `closed_at` |
| `progress` | `0–100` | 人工进度 | 按 status 派生（todo 0 / doing 50 / review 80 / done 100 / blocked 0），标「估算」 |
| `closed_at` | ISO ts（派生） | 进入 done/accepted 的时间 | 旧账本：无（开放端） |

**账本事件**：新增 `{"event":"plan","id",prio?,start?,due?,progress?}`，只覆盖出现的字段；
`fold` 对 `plan` 单独分支（不得落入 status 分支，避免 plan 编辑伪造 `updated_at` 的语义）；
`status` 事件在进入 `done|accepted` 时写 `closed_at`，回到进行态时清除。

**旧账本兼容**：additive，无需迁移；无字段走 §3 兜底，UI 不得因缺 `prio/progress` 抛错。

## 4. Graph 契约（schema 1，additive）

`GraphNode` 增加（全部可选）：`prio`、`start`、`due`、`progress`、`progress_derived`、`created_at`、`updated_at`、`closed_at`、`deps`、`touches`。
`Graph` 顶层增加 `capabilities: ["prio","timeline","progress"]`。
`schema` 仍为 `1`；输出必须**确定性**（不写生成时间、不依赖 locale、稳定排序），满足现有「两次 `--json` 字节相等」测试。
补 `tests/fixtures/graph.v1.json` 作为 additive 回归网。

## 5. 渲染与安全

- 数据注入：`<script type="application/json" id="dia-graph">`，序列化时 `JSON.stringify(x).replace(/</g,'\\u003c')`；
- 模板内 JS 只读该 JSON，不拼接未转义的 label/owner；`progress` 一律 `Number()` 钳位；
- `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`；
- **字段白名单**：只导出 id/title/status/prio/start/due/progress/deps/touches/owner；**永不导出** `evidence` / `closure_reason` / `blocked_reason`；
- `--redact`：owner 变短 hash、touches 只保留文件名；
- 默认输出 `~/.dia/export/graph-<YYYYMMDD-HHmm>.html`，权限 `0600`，stdout 只打印路径；`--out <path>` 可覆盖（拒绝覆盖已存在文件，除非 `--force`）。

## 6. 交互（沿用 mockup，去掉演示态）

- 两种布局：优先级泳道（P 数字升序，`P?` 最后）/ 依赖视图（深度从左到右）；
- **不折叠**；默认时间窗「近 7 天开始（按 start，缺失=始终可见），结束不限」；可选 14/30/全部；
- 搜索：选中回显 tag（`sel` 多选），`↑↓/Enter/Esc/Backspace/×`；
- 聚焦：邻域 1/2/全链路；**sel 与时间窗取交集**（避免 URL 表达矛盾；空交集给出提示）；
- 时间线：左侧固定列、缩放 14–84px/天、开放端用渐隐箭头；日期刻度按可用宽度动态取步长；
- 抽屉：只读详情；原「介入」区改成**复制命令**（`dia msg send …` / `dia task plan …`），不假装能发送。

## 7. 异常与边界

- 空账本 → 空态页（说明如何 `dia task add`），不渲染空泳道；
- 依赖环 → 顶部警示条，环内任务正常渲染；
- 超大账本（>500）→ 渲染前 N 条 + 顶部「已截断 N 条，用 `--all` 渲染全部」；时间线行高固定、后续再虚拟化；
- 时区：所有日粒度换算用本地日（手拼 `YYYY-MM-DD`），禁止 `toISOString()` 参与日粒度比较；
- `from/to` 深链与 `w` 互斥：改 `w` 时清空 `from/to`。

## 8. 测试 / 验收

- 单测：plan 往返、plan 不覆盖未提供字段、旧账本可读、graph 确定性、fixture 兼容、HTML 注入转义（`</script>`）、无外链/无 `fetch(`/无 `node:http`、空账本、截断、红action；
- 视觉：Edge headless 截图 4 张（优先级/依赖/详情/时间线）人工验收；
- judge：

```bash
bun test tests && bash tests/smoke.sh && \
T=$(mktemp -d) && DIA_ROOT=$T bun packages/cli/src/index.ts graph --export-html --out $T/g.html --now 2026-11-06T10:00:00Z >/dev/null && \
grep -q '__DIA_GRAPH__\|id="dia-graph"' $T/g.html && ! grep -Eq 'fetch\(|node:http|src="http|@import' $T/g.html
```

## 9. 发布顺序（每步可独立 MR）

1. **M1a 数据**：`task.ts`（字段 + plan + closed_at）+ CLI `dia task plan` + 单测；
2. **M1b 契约**：`graph.ts` 增字段 + `capabilities` + fixture + TUI 兼容（未知字段忽略）；
3. **M1c 渲染**：`src/graph-html/{template,render}.ts` + 测试；
4. **M1d 入口**：`--export-html/--out/--redact/--now/--all` + smoke + 文档；
5. M2 live 服务另立设计（`packages/graph-web`，loopback + token + 只读 API）。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 模板塞进 TS 后难维护 | mockup 保留为设计源；模板只做数据换源；结构 marker 测试 |
| 缺 start 的旧账本被「近 7 天」隐藏 | 缺失 = 始终可见（§3） |
| 派生 progress 被当真实进度 | `progress_derived` + 斜纹 + 「估算」标注 |
| 导出件含内部信息 | 白名单 + 0600 + 文档警示；`--redact` |
| 不折叠 → 1000 任务画布 23 万 px | 默认截断 + 提示；M2 再做虚拟化 |
| 双击/单击手势冲突 | 单击=抽屉，长按/⌘ 点击=选中；或抽屉改「详情」按钮（M1c 定稿前实测） |
