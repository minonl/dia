# dia / yan / dabo 现状总览

> **2026-11-27 实测（dia 0.1.8）**。本页是三方合起来的「现在长什么样」；`docs/status.md` 管 dia 的阶段与证据，
> 各域仓库管自己的知识与协议。**没跑过的不写「已验证」**；结论都能用 §6 的命令复验。
> 长期方向（不是现状）见 [`vision.md`](vision.md)。

---

## 0. 一句话

**dia 是控制面，不是 agent。** 宿主（opencode / dsh / codex）里能选的只有 `yan`（工作域）和 `dabo`（个人域）；
dia 负责「装谁、跑哪版、知识在哪、动作留不留痕」。

```
dia （控制面：persona / kit / kb / audit / msg / job / wt / service）
 ├── yan   工作域：工作域流程、仓库坑、技能；数据根 ~/.yan-agent    （宿主默认 agent）
 └── dabo  个人域：个人知识、工具、策略；数据根 ~/.dabo-agent
```

---

## 1. 三方对照（2026-11-27）

| 维度 | dia | yan | dabo |
|---|---|---|---|
| 角色 | superagent / agent-team 生成与维护工具（控制面，无业务数据、无运行时） | 工作域 superagent（工作域 · 偏前端） | 个人助理 superagent（游戏 / 生活 / 个人项目） |
| 仓库 | `minonl/dia`（**public**） | `~/.yan-agent/repos/yan-agent`（private） | `~/repos/github/dabo-agent`（private） |
| 安装产物 | npm 全局包 `@minonl/dia`；数据根 `~/.dia` | `~/.dia/personas/yan/<ver>` + `~/.config/opencode/agents/yan.md` + `~/.dsh/profiles/yan` | 同构：`personas/dabo/<ver>` + `agents/dabo.md` + `~/.dsh/profiles/dabo` |
| 版本 | `0.1.8` | persona `0.1.0+g2091d04`（23 个本地版本） | persona `0.1.0+gd65941c`（7 个本地版本） |
| 知识根 | —（只读别人的） | persona 树 `core/knowledge`（119 篇） | persona 树 `core/knowledge`（12 篇） |
| 数据根 | `~/.dia`（persona/kit/消息/审计/任务/索引） | `~/.yan-agent` | `~/.dabo-agent` |
| 宿主 | —（被调用） | opencode 2.3.2 / dsh 0.2.1-rc.2 | 同左；dsh profile 端口动态 |
| 域命令 | 见 §2 | 16 个（`kb scene/rule/query/...`、`mr`、`release`、`schedule`、`data`） | 2 个（`todo`、`welcome`） |
| 生效方式 | 命令直跑 | opencode `default_agent=yan`；dsh profile | 显式选 agent / `dsh --profile dabo` |
| 装态 | — | 本地源 `local-only`；内容校验 ok | 本地源 `local-only`；内容校验 ok |

> `dia persona check` 对本地源只比对内容哈希，**不比对上游**（`上游 (未知) → local-only`）。

---

## 2. dia 能力面（2026-11-27 实测）

**已实现**

| 组 | 命令 |
|---|---|
| 知识 | `kb index / search / query / get / lint / path / review`；`--persona` 作用域下自动重建过期索引 |
| 采集 | `ingest sessions（dsh/opencode）/ ingest git`，脱敏 + 幂等 |
| 审计 | `audit append / verify / score / tail`（**哈希链已实现**）；`freeze / thaw`；`guard`；`run / resume` |
| persona | `add / create / render / list / verify / remove / show / use / path / check / update / default / gc`（含 `--force`、`--dry-run`、`--check`） |
| 内容包 | `kit add / list / verify / remove / gc` |
| 自检 | `doctor`（多 persona 逐个自检；`--persona` 单查；exit 0/1/2） |
| 协作 | `msg send/inbox/show/ack/reply/close/deliver/retry/escalate/upkeep`；`collab status/enable/disable/stats/board/observe`；`whoami` / `in` / `out` / `ack` / `reply` 别名 |
| 运行面 | `env list/check/run`（含 bw）、`deps list/record`、`wt …`、`cmd` / 一级委派、`task`、`team run/gate/accept/reject/next`、`job`、`service`、`graph` / `workbench`、`price`、`version`、`update`、`postinstall` |

**未实现（有设计、无命令）**

| 项 | 现状 | 出处 |
|---|---|---|
| `patch …` | `unknown command` | `docs/patching.md` |
| `persona activation` | 无（只能 `use` / `default`，下次会话生效） | `docs/versioning.md` |
| `kit create / update / show` | 只有 `add/list/verify/remove/gc` | `docs/kit-install.md` |
| ModelSpec / 基准 sidecar（D2） | 未做（已有 `price` 计价） | `docs/model-*.md` |
| state 事件 / `(T,D,O)` 视图（D3） | 未做 | `docs/evolution-process.md` |
| PR canary（D4） | 未做 | `docs/status.md` |
| IM bridge / ACP server | 未做 | `docs/entrypoints.md`、`docs/acp-integration.md` |

> 曾经写进文档但**不存在**的命令：`dia status`、`dia model`（观测入口目前只有 `dia doctor`）。
> `codex` 渲染已在代码里支持（假 HOME 隔离），但 `docs/platforms/registry.json` 仍标 `supported:false` —— 口径未收口。

---

## 3. 本机实际状态（2026-11-27 复验）

```
$ dia version                    → 0.1.8
$ dia doctor                     → verdict: warn
                                   2/24 个定时任务最近一次非 ok：
                                   dws-auth-check: failed（periodic）
                                   case-intake: failed（periodic）
                                   （其余 persona / kb / deps / platform 全绿）
$ dia persona list               → yan: 23 个版本 / dabo: 7 个 / dia-evoler: 1 个
$ dia persona check dabo         → local-only，内容 ok（d65941c）
$ dia persona check yan          → local-only，内容 ok（2091d04）
$ dia persona default --show     → yan
$ dia job list                   → 25 条 task（24 条有 state）
$ bun test tests                 → 1188 pass / 4 skip / 0 fail（1192 tests / 119 files，~134s）
$ dia deps list                  → 6 条一致（acpx 可选未装）
$ dia collab stats --since 30d   → 724 条；delivered 44.6% / ack 12.5% / reply 0.4%；backlog 531
$ wc -l ~/.dia/audit/audit.jsonl → 5 行（最后 2026-11-04）
$ dia service list               → 无
```

存储：`~/.dia/personas` 475MB（yan 22 个旧版本可 `persona gc`）、`~/.dia/cache` 37MB（其中 32.7MB 无引用）、`~/.dia/collab` 9.1MB。

---

## 3.1 CI 口径（见 README「CI 矩阵」）

- required = `test (ubuntu-latest)` + `test (macos-latest)`（分支保护，`enforce_admins`）
- `windows-smoke` 非阻塞：Windows 后端未实现（`dia job install` rc=3），落地后再升 required
- **docs-only 快通道**：只改 `docs/**` / 根 `*.md` / `llms*.txt` 时跳过测试矩阵

---

## 4. 已知缺口（按优先级）

1. **`dia doctor` 当前是 warn**：2 个定时任务失败（`dws-auth-check`、`case-intake`）。先看 `dia job logs <name>`，不要用「doctor 全绿」当唯一判据。
2. **协作面名义在用、实际未闭环**：30 天 724 条，reply 0.4%，backlog 531；历史 `escalated` 492。机器流量（dws-hub）占大头，缺 TTL/批量关闭/分账。
3. **公开 release 残留**：当前树已脱敏、0.1.8 tarball `hits=0`；但 **Git 历史仍有 7 个提交含旧标识**；npm `0.1.0–0.1.5` 已 deprecate、tarball 仍可下载（超 72h，需 npm support 才能删）。
4. **persona 本地源**：`check` 无法比对上游（local-only）；`update` 可用，但「落后多少」看不出来。
5. **`verify` 只看内容哈希**，宿主产物漂移要靠 `render --check`（两个命令给不同答案，容易误判）。
6. **凭据放行粒度**：bw 按账号/collection 分组，任务级最小权限与调用审计都缺；见 `docs/security/credentials.md`。
7. **存储无保留策略**：persona 22 个旧版本、cache 32.7MB 无引用；`gc` 从未自动跑。
8. **PR #257 未合**：persona 数据根授权合成只对 opencode 生效，dsh/codex 本期不生效。

---

## 5. 文档地图（按现状分级）

| 级别 | 文档 | 说明 |
|---|---|---|
| **现状（可依赖）** | `overview.md`（本文，2026-11-27）、`status.md`（2026-11-03 快照 + 11-27 补丁）、`cli.md §4.1`、`persona-install.md`、`monorepo.md`、`team.md`、`pricing.md` | 与代码/本机一致 |
| **设计（部分未实现）** | `architecture.md`、`entrypoints.md`、`kit-install.md`、`versioning.md`、`patching.md`、`team-automation.md`、`security-sandbox.md`、`dependency-registry.md`、`acp-integration.md`、`proposals.md` | 保留意图，文首/文中标注实现范围 |
| **迁移与发版** | `migrations/llm-migration.md`、`../scripts/release.sh` | 迁移用 LLM 任务；发版打 tag + GitHub Release |
| **方向（不是现状）** | `vision.md` | 长期定位：superagent/team 工厂、平台版本经验库、fleet（openrig）边界 |
| **平台经验** | `platforms/registry.json`（数据）+ `platforms/index.md`（规则/用法） | 单一事实源；`dia doctor` 派生人读视图；不记录设备 |
| **理论 / 研究** | `evolution-process.md`、`model-behavior.md`、`model-baseline-sidecar.md`、`host-control-surface.md`、`ecosystem-*.md`、`research/*` | 供推导，不作为现状 |
| **留痕** | `migrations/*`（除 current）、`review/*`、`research/h0/*` | 当时结论，可能被后续推翻 |

---

## 6. 复验命令（照抄可跑）

```bash
dia version && dia doctor
dia persona list && dia persona check dabo && dia persona check yan
dia persona render dabo --check && dia persona render yan --check
dia --persona dabo kb query "边界"        # 必须只命中 dabo 的知识根
dia --persona yan kb scene S1             # 工作域场景卡
cd ~/repos/github/dia && bun test tests   # 1192 tests（1188 pass / 4 skip）
npm view @minonl/dia dist-tags            # latest 应为 0.1.8
git log --all -S"<token>" --oneline        # 历史残留检查（应为空才是干净）
```

---

## 7. 0.1.x 发布与安全事件（2026-11-27）

| 版本 | 内容 | npm |
|---|---|---|
| `0.1.6` | kit change-contract | **已撤回**（registry 中不存在） |
| `0.1.7` | 当前树脱敏（#259） | 已发布（`latest` 直到 0.1.8） |
| `0.1.8` | pre-push 私有词表（#261） | **`latest`** |

- 当前树脱敏：品牌 / 内网域名 / 仓库组 / 项目名 / 家目录 → 通用占位；
- pre-push 新增私有词表（`$DIA_SENSITIVE_FILE`，默认 `~/.config/dia/sensitive.txt`，**不入仓**），任何文件类型命中即阻断；
- 残留：Git 历史 7 个提交仍含旧标识；npm `0.1.0–0.1.5` 只能 deprecate。
