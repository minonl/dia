# Python 清理：Node/Bun 项目不收 Python

> 日期 2026-10-30。目标：dia 仓库不把 Python 作为运行时/工具链依赖。

## 现状

| 区域 | 状态 |
|---|---|
| `experiments/*.py` | ✅ 已迁到 `experiments/*.ts`（Bun） |
| `src/` / `packages/kb` / `packages/cli` | ✅ 无 Python |
| `packages/job/bin/dia-job` | ⚠️ **遗留**：JSON 解析/写回仍在调用 `python3`（约 15 处） |
| `packages/job/tests` | ⚠️ 测试夹具仍用 `python3` |

## 为什么还没清完

`packages/job` 是从 bash 调度器继承的 OS 适配层；当初用 `python3` 做 JSON 解析。
dia 的 `engines` 只声明 Node/Bun，**public 用户机器不保证有 python3**，所以这是公开前阻断项，不是“可接受例外”。

## 计划（P3）

1. 新增 `packages/job/lib/json.mjs`：`get/set/del/labels/status/check` 等子命令，统一 JSON 读写；
2. 逐处替换 `python3 -c` / heredoc，保留现有 bash 退出码与输出格式；
3. 测试夹具改为 `node`/`bun` 内联脚本；
4. 新增门禁：`rg -n 'python3?|\.py\b' packages/job` 必须为 0；
5. 宁可保留一个明确的 Node 依赖，也不让 public 用户装 Python。

## 当前结论

- dia 自研代码：Python 清零；
- `packages/job`：**public release blocker**，P3 完成前不得公开。
