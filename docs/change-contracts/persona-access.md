# 变更契约：persona 数据根授权合成（`access`）

> 变更：`dia.json` 新增 `access: {read, write, env}`，`persona add/render/use` 在 opencode agent
> frontmatter 的 `permissions` 尾部合成数据根规则。
> 分支：`feat/persona-access`；判据：`bun test tests` + 沙箱端到端（见 §证据）。

## 变更影响面

- 分级：A
- 确认人：min（2026-11-26「dia 团队产品、设计、开发、测试一起自动推进」）
- 依据：需求面原文「对于 dabo 的数据根，应该始终有权限……需要优化下」+「以彻底解决而不是绕过或临时方案」；
  实现路径经三轮对抗评审与独立验收（15 + 11 + 8 条 finding 全处理，秤判「通过」）。

| # | 字段 | 改动前 | 改动后 | 判定 | 依据 & 确认人 |
| --- | --- | --- | --- | --- | --- |
| 1 | 取数方式（全量 / 分页 / 游标 / 增量） | 读 persona 源 entry + `dia.json` | 同左（不新增数据源） | 不变 | 合成只用已有两份输入 |
| 2 | 触发方式（滚动 / 按钮 / 自动轮询） | `persona add` / `render` / `use` 时渲染 | 同左（无后台/轮询/自动触发） | 不变 | 无新触发器 |
| 3 | 顺序与页大小（排序键、稳定性） | 作者手写 `permissions`，顺序自定 | `permissions` **尾部**固定顺序：`external_directory` → `read` → `edit(allow/deny)` → `.env ask` | 需求内 | opencode 后匹配者胜；规则必须排在 `* ask` 之后才生效；确认人 min |
| 4 | 加载态（首屏 / 追加 / 重试） | 无输出 | 默认输出一行 `access: 追加 N 条（跳过 M）→ <root>`；`--json` 走 `access` 字段 | 需求内 | 安装即授权必须可见；确认人 min |
| 5 | 结束态（没有更多 / 上限提示 / 到底） | 成功 exit 0；各类错误 31/1/2 混杂 | 授权类失败（坏 frontmatter / 非法 data_root / 更宽 deny 冲突 / 坏 lock）统一 **exit 32**；`--check --rehome` **互斥 exit 2** | 溢出已确认 | 失败必须可辨识、不得「静默成功」；确认人 min |
| 6 | 计数文案（总数 / 已加载 / 命中数） | 无计数 | `added` = 本次合成新增条数；`skipped` = 源里已有条数；`missing` = dest 相对期望差几条（只在 render/--check 报） | 溢出已确认 | 可审计、避免同一字段两种含义；确认人 min |
| 7 | 空态与错误态 | 无 access 时原样拷贝 | 无 access：产物**逐字节不变**；坏 frontmatter / 坏 lock：拒绝并给行号，不写盘 | 需求内 | 零回归是硬约束；确认人 min |
| 8 | 搜索与筛选（是否回退、是否分页） | 无参数 | 新增 `--rehome`：HOME 变化时显式改写路径并更新 lock；否则跨 HOME 一律拒绝 | 溢出已确认 | 防止共用 `DIA_ROOT` 时静默把别人家目录授权出去；确认人 min |

**依赖面**：新增运行时依赖 `yaml@^2.9.1`（ISC），`bun build` 后 dist +233 KB。
判定：需求内（文本手术无法彻底解决；实测 8 类合法 frontmatter 全部保留）。

## 回滚

1. `dia.json` 删除 `access` 字段 → 产物回到「仅作者手写规则」形态（逐字节不变），无需改代码。
2. 需要彻底回退实现：回退分支 `feat/persona-access`；已渲染文件用旧版 `dia persona render <id>` 重渲染。
3. `dia.lock` 里的 `access` 字段可忽略，旧版读取不受影响（未知字段不参与校验）。

## 证据（验收时复跑）

```bash
cd /home/min/repos/github/dia/.worktrees/feat-persona-access
bun test tests            # 1274 pass / 0 fail
bun run build             # cli.js 1.0 MB
```

沙箱端到端（隔离 `DIA_*`）：`persona add` → 5 条规则顺序正确、`opencode --standalone debug agents`
能看到该 agent；无 access 的 persona 产物与源 `cmp` 逐字节相同；`data_root: "~/.ssh"` → `E_MANIFEST` exit 32 且无产物。
