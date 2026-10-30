# Python 清理：Node/Bun 项目不收 Python

> 日期 2026-10-30。目标：dia 仓库不把 Python 作为运行时/工具链依赖。

## 现状

| 区域 | 状态 |
|---|---|
| `experiments/*.py` | ✅ 已迁到 `experiments/*.ts`（Bun） |
| `src/` / `packages/kb` / `packages/cli` | ✅ 无 Python |
| `packages/job/bin/dia-job` | ✅ 已改用 `lib/json.mjs`（Node/Bun 内置 JSON） |
| `packages/job/tests` | ✅ 测试夹具已改 Node |

## 迁移记录

`packages/job` 是从 bash 调度器继承的 OS 适配层，原先用 `python3` 做 JSON 解析。
现已改为 `lib/json.mjs`：只用 Node/Bun 内置 JSON，不新增 workspace 包/解析器。

## P3 完成（2026-10-30）

1. ✅ `packages/job/lib/json.mjs`：labels/entries/get/set/del/rows/fields/backfill/selfcheck-rows/expected/bootstrap-rows；
2. ✅ `packages/job/bin/dia-job` 无 `python3`；
3. ✅ `packages/job/tests` 夹具改 Node；
4. ✅ `rg -n 'python3?|\.py\b' packages/job` 为 0；
5. 运行时要求：Node 或 Bun（`engines` 已声明）。

## 当前结论

- dia 全部 Python 清零（含 job）；
- JSON 适配层不新增包，只用内置 JSON；
- JSONC/JSON5 未默认引入，按 `no-python` 策略按需 opt-in。


## JSON / JSONC / JSON5 兼容策略

不新写 JSON 解析器，也不把 JSON 支持做成 workspace 包；只用 Node/Bun 内置 JSON + 一层薄适配。

| 文件 | 规则 |
|---|---|
| `*.json`（registry/state/`dia.json`） | **严格 JSON**；机器写入，不接受注释/尾逗号 |
| `*.jsonc`（人工配置，若引入） | 允许注释/尾逗号；读取兼容，写回 canonical JSON 并提示“注释会丢失” |
| `*.json5` | **不默认支持**；单引号/无引号键/NaN 会扩大歧义面，只在明确需求时 opt-in |
| `key=value` 配置 | 继续用现有 env/config 格式，不改成 JSON |

实现约束：

- 不写自定义 parser，不用 `eval`；
- JSONC 若落地，使用固定版本的成熟解析器（如 `jsonc-parser`），并只对 `.jsonc` 生效；
- job 的 `registry.json` / `state.jsonl` 永远 strict JSON，JSONC 只用于用户配置；
- 写入始终原子化，不能因为兼容格式破坏状态文件。

**结论**：兼容优先做 `JSON` + `JSONC`；`JSON5` 先不做，避免为了“宽松”把机器状态也弄脏。
