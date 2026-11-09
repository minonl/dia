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

> 判定方式：命令实跑 + `bun test tests`（286 tests / 39 files 全绿）+ 代码入口。写"未实现"的项当前是 `unknown command`。

| 命令 | 状态 | 证据 / 备注 |
|---|---|---|
| `persona add` | **已实现** | 本地目录、`git+https://…`、`--ref`、`--host opencode\|dsh`、`--dry-run`、`--force`（覆盖 agent md **与内联内容**，覆盖前备份）；渲染 + `dia.lock` |
| `persona list / verify / remove` | **已实现** | verify 校验内容哈希 + 自带内容产物（files 复制、skills 软链）；remove 按 lock 回收，手改的 skip |
| `persona show <id>` | **已实现** | 生效版本 + 最近 5 次切换审计 |
| `persona use <id>[@ver]` | **已实现** | 生效指针 `state/active.json` + 审计 `active.jsonl`；scope 先读指针，无指针回退最新 |
| `persona path [<id>[@ver>]]` | **已实现** | 生效版本目录；`--json` 出 `{id,version,dir,source,commit}`；未装即非 0 退出（消费方大声失败） |
| `persona check <id>` | **已实现** | 上游比对 same / differs / unknown / local-only；exit 0/1/3，内容被改 exit 2 |
| `persona update <id>` | **已实现** | 从 lock 记录的 source+ref 重装，并把 active 指向新版本；本地源亦可；`--force` 覆盖宿主/内联内容冲突（先备份） |
| `persona default <id>` | **已实现** | 改宿主 `default_agent`：备份原文件 + 记原值，`--unset` 精确还原；非严格 JSON 直接拒绝 |
| `persona create / render` | **已实现** | `create` 出骨架；`render --check` 只比对不写盘（跳过宿主自写文件，如 dsh `cordis.yml` / `package.json` / 锁文件）；`render` 只覆盖 persona 产物，不整树重建宿主 profile |
| `kit add / list / verify / remove` | **已实现** | 复制/软链/记账；冲突写盘前全量检查（`E_CONFLICT`）；**空清单/空内容拒绝**（`E_MANIFEST`/`E_KIT_EMPTY`）；`src/kit.ts` + `tests/kit.test.ts` |
| `env list / check / run` | **已实现** | 白名单注入、不回显值、`--redact`、密钥不进 argv；清单由 persona 声明（`src/env.ts` + `tests/env.test.ts`） |
| `postinstall` | **已实现** | 全局安装后自举：装配内置 `dia-msg` kit + 写自举戳；幂等、永不失败（供 npm `postinstall` 与 `--ignore-scripts` 用户手动补跑） |
| `migrate data [--from DIR] [--dry-run]` | **已实现** | 旧数据根 → `~/.dia`：只搬数据子目录，目标已存在则合并，失败计数退 1（取代已删除的 `install.sh --migrate`） |
| `update [--check]` | **已实现** | 查 npm `dist-tags`；`--check` 有新版 exit 1、领先/最新 exit 0；**按安装方式分流**：npm 全局包 → `npm i -g`；脚本安装 → **统一引导切到 npm**（`npm i -g` + 回链），`bash install.sh` 只作为「开发/离线通道」备选 |
| `deps list / record` | **已实现** | `list` = 登记 + 实测派生视图（required 缺失 exit 2）；`record` = 只追加一行（`--id/--kind/--version` 必填）；`src/deps.ts` + `tests/deps*.test.ts` |
| `doctor` | **已实现** | 组合自检：persona verify / **persona.render（宿主产物只读漂移，warn + 修复命令）** / default_agent / kit（**只查该 persona 引用的**，孤儿 kit 不拖红）/ knowledge（**索引新鲜度三态**，过期给重建命令）/ dsh preset / **deps 登记校验** / **platform 版本（读 `docs/platforms/registry.json`）** / wt / **install_shadow（遮蔽提示，warn）** / **bootstrap（内置能力是否跟随包版本）**（脚本安装 vs 包管理器全局安装互相遮挡：双向一致判定，不一致 fail + 一行修复命令；shim 形态按内容识别）**；exit 0/1/2。不指定 persona 且装了多个 → **逐个自检**（条目加 `<id>.` 前缀），不再整体 `E_SCOPE` |
| `wt …` | **已实现（需安装包）** | 转发 `packages/wt/bin/dia-wt`（create/adopt/doctor/gate/list/status/check/clean/prune-merged；详见 [worktree.md](worktree.md)）；未装时 `E_WT`（exit 33），`install.sh` 会分发 |
| `kb index/search/query/get/lint/path/review` | **已实现** | persona 作用域下索引过期自动重建；显式 `--root` 保持「缺索引即报错」 |
| `kb <域命令>` | **已实现（委派）** | 未命中内置 → persona `commands` → 委派；argv 透传、exit code 原样 |
| `<persona-cmd>` / `cmd <name>` | **已实现** | 一级委派（内置优先）；`dia cmd` 只查外部命令，可绕开同名内置 |
| `collab board / observe` | **已实现** | `observe` 恒为一次性 tick（无守护；定时用 `dia job`，建议 300s）→ board/metrics/escalations（0600、去重、无正文）；`board` 默认只读（缺失/过期内存现算 + stale 标记），`--refresh` 落盘、`--cached` 只读 |
| `collab stats` | **已实现** | 只读聚合：delivered/exposed/ack/reply 率、deliver_lag、reply_latency（median/p90/censored）、backlog（orphan/by_class）；cohort 按 created_at 入窗 |
| `task add/list/link/plan/split/status/done` | **已实现** | done 需 judge + evidence；`plan` 写计划态（prio/start/due/progress）；`split` 父 depends on 子（单条原子事件，judge 继承） |
| `graph [--json] [--task T] [--tui …] [--export-html] [--next/--explain/--lint/--seats]` | **已实现** | 图 JSON（schema 1 + capabilities）；节点带 prio/start/due/progress + 派生 `eff_prio/ready/rank/unblocks/critical` 等；`--export-html` 单文件 HTML；`--next [n]` / `--explain <id>` / `--lint` 只读编排（Kahn-v1）；`--next --seats N [--presence-ttl 30m]` 固定席位分配（seats-v1，见 [seat-scheduling-m2.md](design/seat-scheduling-m2.md)） |
| `team run --mock / --acp / --dsh`、`team gate/accept/reject` | **已实现** | 状态机 + 门禁；成功/失败路径均跑通 |
| `job …` | **已实现** | 转发 `packages/job`（launchd/cron/schtasks） |
| `patch …` | **未实现** | 当前 `unknown command`；设计见 `docs/patching.md` |
| `ingest / audit / freeze / run / resume / price` | **已实现** | D0 阶段交付 |

证据入口：`bun test tests`；`tests/kit.test.ts`、`tests/scope.test.ts`、`tests/env.test.ts`、`tests/active-doctor.test.ts`。

## 5. 与安装文档的关系

- 清单格式与安全规则见 `docs/persona-install.md`；
- 入口与默认 agent 规则见 `docs/entrypoints.md`。
