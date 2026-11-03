# dia CLI 词表（动作规范）

> 日期 2026-10-28。原则：**动作成对、名词分层、不混轴。**
> 名词：`persona`（可被选中的 agent 定义）、`kit`（知识/技能/工具内容）、`profile`（dsh 宿主组合，不对外当命令）。

---

## 1. 动词矩阵

| 动作 | 含义 | 反义/配套 | 示例 |
|---|---|---|---|
| **add** | 从 git/本地取回 → 校验 → 渲染 → 登记 lock/deps | **remove** | `dia persona add dabo --from git+... --ref <sha>` |
| **remove** | 注销 + 删除带 `managed-by: dia` 的产物 | add | `dia persona remove dabo` |
| **create** | **本地生成**一个新骨架（`dia.json` + 最小文件） | （无；不是安装） | `dia persona create mybot` |
| **update** | **换内容**（ref→新 commit）+ 重渲染；旧版本备份；运行中会话不切换 | — | `dia persona update dabo --ref <sha>` |
| **render** | **不换内容**，只把已安装版本重渲染到宿主（宿主升级/文件漂移） | — | `dia persona render dabo --host dsh` |
| **verify** | 清单/哈希/版本校验 | — | `dia persona verify dabo` |
| **list / show** | 列出 / 看详情 | — | `dia persona list` |
| **path** | 打印**生效版本目录**（服务/脚本取代码的稳定入口） | — | `dia persona path yan` |
| **add / remove**（kit） | 同上，作用于内容 | — | `dia kit add git+...` |

**不要用**：
- `install/uninstall`（与 add/remove 重复，且暗示系统级安装）；
- `preset`（宿主概念，不当作名词）；
- `pkg`（npm 语义，暗示依赖/执行）。

---

## 2. 名词与子命令

> **2026-11-03 注**：下面的 `kit create/update/show`、`patch`、`persona activation` 是**目标态**；
> 实际已实现的命令与证据见 §4.1（`persona activation`、`patch` 当前是 `unknown command`）。

```
dia persona add|remove|create|update|render|verify|list|show
dia kit     add|remove|create|update|verify|list|show
dia patch   create|add|list|verify|revert|export
dia persona activation <id> --mode next-session|active-additive|active-all|manual
```

**默认行为约束**：
- `add` 只新增/渲染，**不改默认 agent**、不碰 yan；
- `remove` 只删 `managed-by: dia` 的文件，用户手改过的拒绝删除；
- `create` 不联网、不执行脚本，只写骨架；
- 所有写动作支持 `--dry-run`。
- **按能力热更新**：T3 增量可 `--apply active`；破环性变更只允许 `--apply next-session`；`--activate-now` 需 `--i-am-human`。

---

## 3. 退出码

| 码 | 含义 |
|---|---|
| 0 | OK |
| 2 | 用法错误 |
| 30 | degraded（已回退/部分宿主缺失） |
| 31 | 配置/鉴权失败 |
| 32 | 清单/冲突（E_MANIFEST / E_CONFLICT） |
| 33 | 能力缺失（capabilities 不支持该动作） |

---

## 4. 示例

```bash
# 安装 dabo 人格（只新增，不改默认）
dia persona add dabo --from git+https://github.com/minonl/dabo-agent.git --ref <sha> --dry-run
dia persona add dabo --from git+... --ref <sha>

# 从零写一个新人格
dia persona create mybot --dir ~/repos/mybot

# 宿主升级后重渲染
dia persona render dabo --host dsh

# 校验/卸载
dia persona verify dabo
dia persona remove dabo
```

---

## 4.1 实现状态（2026-11-03 复核）

> 判定方式：命令实跑 + `bun test tests`（198 tests / 30 files 全绿）+ 代码入口。写"未实现"的项当前是 `unknown command`。

| 命令 | 状态 | 证据 / 备注 |
|---|---|---|
| `persona add` | **已实现** | 本地目录、`git+https://…`、`--ref`、`--host opencode\|dsh`、`--dry-run`、`--force`（覆盖已存在产物，覆盖前备份）；渲染 + `dia.lock` |
| `persona list / verify / remove` | **已实现** | verify 校验内容哈希 + 自带内容产物（files 复制、skills 软链）；remove 按 lock 回收，手改的 skip |
| `persona show <id>` | **已实现** | 生效版本 + 最近 5 次切换审计 |
| `persona use <id>[@ver]` | **已实现** | 生效指针 `state/active.json` + 审计 `active.jsonl`；scope 先读指针，无指针回退最新 |
| `persona path [<id>[@ver>]]` | **已实现** | 生效版本目录；`--json` 出 `{id,version,dir,source,commit}`；未装即非 0 退出（消费方大声失败） |
| `persona check <id>` | **已实现** | 上游比对 same / differs / unknown / local-only；exit 0/1/3，内容被改 exit 2 |
| `persona update <id>` | **已实现** | 从 lock 记录的 source+ref 重装，并把 active 指向新版本；本地源亦可 |
| `persona default <id>` | **已实现** | 改宿主 `default_agent`：备份原文件 + 记原值，`--unset` 精确还原；非严格 JSON 直接拒绝 |
| `persona create / render` | **已实现** | `create` 出骨架；`render --check` 只比对不写盘（跳过宿主自写文件，如 dsh `cordis.yml`） |
| `kit add / list / verify / remove` | **已实现** | 复制/软链/记账；冲突写盘前全量检查（`E_CONFLICT`）；`src/kit.ts` + `tests/kit.test.ts` |
| `env list / check / run` | **已实现** | 白名单注入、不回显值、`--redact`、密钥不进 argv；清单由 persona 声明（`src/env.ts` + `tests/env.test.ts`） |
| `doctor` | **已实现** | 组合自检：persona verify / default_agent / kit / knowledge / dsh preset / **deps 登记校验** / **platform 版本（读 `docs/platforms/registry.json`）** / wt；exit 0/1/2。不指定 persona 且装了多个 → **逐个自检**（条目加 `<id>.` 前缀），不再整体 `E_SCOPE` |
| `wt …` | **已实现（需安装包）** | 转发 `packages/wt/bin/dia-wt`；未装时 `E_WT`（exit 33），`install.sh` 会分发 |
| `kb index/search/query/get/lint/path/review` | **已实现** | persona 作用域下索引过期自动重建；显式 `--root` 保持「缺索引即报错」 |
| `kb <域命令>` | **已实现（委派）** | 未命中内置 → persona `commands` → 委派；argv 透传、exit code 原样 |
| `<persona-cmd>` / `cmd <name>` | **已实现** | 一级委派（内置优先）；`dia cmd` 只查外部命令，可绕开同名内置 |
| `task add/list/status/done` | **已实现** | done 需 judge + evidence |
| `team run --mock / --acp / --dsh`、`team gate/accept/reject` | **已实现** | 状态机 + 门禁；成功/失败路径均跑通 |
| `job …` | **已实现** | 转发 `packages/job`（launchd/cron/schtasks） |
| `patch …` | **未实现** | 当前 `unknown command`；设计见 `docs/patching.md` |
| `ingest / audit / freeze / run / resume / price` | **已实现** | D0 阶段交付 |

证据入口：`bun test tests`；`tests/kit.test.ts`、`tests/scope.test.ts`、`tests/env.test.ts`、`tests/active-doctor.test.ts`。

## 5. 与安装文档的关系

- 清单格式与安全规则见 `docs/persona-install.md`；
- 入口与默认 agent 规则见 `docs/entrypoints.md`。
