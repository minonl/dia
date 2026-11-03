# dia / yan / dabo 现状总览

> **2026-11-03 实测**。本条是三方合起来的「现在长什么样」；`docs/status.md` 管 dia 的阶段与证据，
> 各域仓库管自己的知识与协议。**没跑过的不写「已验证」**；结论都能用 §6 的命令复验。
> 长期方向（不是现状）见 [`vision.md`](vision.md)。

---

## 0. 一句话

**dia 是控制面，不是 agent。** 宿主（opencode / dsh）里能选的只有 `yan`（工作域）和 `dabo`（个人域）；
dia 负责「装谁、跑哪版、知识在哪、动作留不留痕」。

```
dia （控制面：persona / kit / kb / audit / job / wt）
 ├── yan   工作域：工作域流程、仓库坑、技能；数据根 ~/.yan-agent    （宿主默认 agent）
 └── dabo  个人域：个人知识、工具、策略；数据根 ~/.dabo-agent
```

---

## 1. 三方对照（2026-11-03）

| 维度 | dia | yan | dabo |
|---|---|---|---|
| 角色 | superagent / agent-team 生成与维护工具（控制面，无业务数据、无运行时） | 工作域 superagent（工作域 · 偏前端） | 个人助理 superagent（游戏 / 生活 / 个人项目） |
| 仓库 | `~/repos/github/dia`（`minonl/dia`，private） | `~/.yan-agent/repos/yan-agent` | `~/repos/github/dabo-agent` |
| 安装产物 | `~/.local/share/dia` + `~/.local/bin/dia` | `~/.local/share/dia/personas/yan/0.1.0` + `~/.config/opencode/agents/yan.md` + `~/.dsh/profiles/yan` | 同构：`personas/dabo/0.1.0` + `agents/dabo.md` + `~/.dsh/profiles/dabo` |
| 版本 | `0.0.1`（package `private`） | persona `0.1.0` | persona `0.1.0` |
| 知识根 | —（只读别人的） | persona 树 `core/knowledge` | persona 树 `core/knowledge` |
| 数据根 | `~/.local/share/dia`（安装/台账/备份） | `~/.yan-agent` | `~/.dabo-agent` |
| 宿主 | —（被调用） | opencode + dsh（profile 3091） | opencode + dsh（profile；webserver 端口动态，默认回退 1111） |
| 域命令 | 见 §2 | 16 个（`kb scene/rule/query/...`、`mr`、`release`、`schedule`、`data`） | 2 个（`todo`、`welcome`） |
| 生效方式 | 命令直跑 | opencode `default_agent=yan`；dsh profile | 显式选 agent / `dsh --profile dabo` |
| 装态 | — | **落后来源仓 1 个提交**（见 §4-1） | 与来源仓一致 |

---

## 2. dia 能力面（2026-11-03 实测）

**已实现**

| 组 | 命令 |
|---|---|
| 知识 | `kb index / search / query / get / lint / path / review`；`--persona` 作用域下自动重建过期索引 |
| 采集 | `ingest sessions（dsh/opencode）/ ingest git`，脱敏 + 幂等 |
| 审计 | `audit append / verify / score / tail`；`freeze / thaw`；`guard`；`run / resume` |
| persona | `add / create / render / list / verify / remove / show / use / path / check / update / default`（含 `--force`、`--dry-run`、`--check`） |
| 内容包 | `kit add / list / verify / remove` |
| 自检 | `doctor`（多 persona 逐个自检；`--persona` 单查；exit 0/1/2） |
| 运行面 | `env list/check/run`、`wt …`、`cmd` / 一级委派、`task`、`team run/gate/accept/reject/next`、`job`、`price`、`version` |

**未实现（有设计、无命令）**

| 项 | 现状 | 出处 |
|---|---|---|
| `patch …` | `unknown command` | `docs/patching.md` |
| `persona activation` | 无（只能 `use` / `default`，下次会话生效） | `docs/versioning.md` |
| `kit create / update / show / gc` | 只有 `add/list/verify/remove` | `docs/kit-install.md` |
| deps 校验（M1） | `deps.yaml` 只登记，`doctor` 不校验 | `docs/dependency-registry.md` |
| audit 哈希链（M3） | 未做 | `docs/status.md` D1 |
| ModelSpec / 基准 sidecar（D2） | 未做（已有 `price` 计价） | `docs/model-*.md` |
| state 事件 / `(T,D,O)` 视图（D3） | 未做 | `docs/evolution-process.md` |
| PR canary（D4） | 未做 | `docs/status.md` |
| IM bridge / ACP server / npm 发布 | 未做 | `docs/entrypoints.md`、`docs/acp-integration.md` |

> 曾经写进文档但**不存在**的命令：`dia status`、`dia model`（观测入口目前只有 `dia doctor`）。

---

## 3. 本机实际状态（复验过的）

```
$ dia doctor                     → verdict: ok（dabo.* / yan.* 逐项 + default_agent + wt）
$ dia persona list               → dabo: 0.1.0 / yan: 0.1.0
$ dia persona check dabo         → same（git main d6b3ff77）
$ dia persona check yan          → local-only（本地 83fbaa9，来源仓 main 已是 8d10cc5）
$ dia persona default --show     → yan
$ dia job list                   → 5 个 launchd 任务（session-diary sync/gc、task selfcheck、job update、yan-reviewer）
$ dia --persona dabo kb query …  → 只命中 dabo 自己的 core/knowledge
$ dia --persona yan kb scene S1  → 正常出场景卡
```

测试与 CI：`bun run test` = 188 tests / 28 files 全绿 + smoke + E2E-1；GitHub Actions ubuntu+macOS 双绿（`4998a1b`）。

---

## 4. 已知缺口（按优先级）

1. **yan 安装落后来源仓 1 个提交**（`83fbaa9` vs `8d10cc5`，内容是 dsh profile 根 `cordis.yml` 修复）。
   修法：`dia persona add yan --from ~/.yan-agent/repos/yan-agent --force`（先备份）。
2. **`dia doctor` 的 knowledge 项只查目录存在**，不校验索引新鲜度；`kb` 索引过期要等查询时才自愈。
3. **`deps.yaml` 与真实环境脱节**：`/opt/homebrew/bin/opencode` 已不存在、`acpx` 不在 PATH，doctor 不校验（M1）。
4. **本地源 persona 不能 `update`**（`E_SOURCE`），只能用 `add --force` 刷新；`update` 尚未支持本地源。
5. **yan 旧脚本未迁**：`yan-env`、`yan-version`、`yan-ref`、`yan-data-root`、`yan-data-sync` 仍是仓库脚本
   （`dia env` / `persona show/use` 已有等价能力，未收口）。
6. **`verify` 只看内容哈希**，宿主产物漂移要靠 `render --check`（两个命令给不同答案，容易误判）。
7. **凭据放行粒度**：bw 按账号/collection 分组，任务级最小权限与调用审计都缺；调研见 `docs/security/credentials.md`。
8. 公开 release 仍 BLOCKED（脱敏 + 历史清洁 + `dia-security` pass，见 `docs/security/public-release.md`）。

---

## 5. 文档地图（按现状分级）

| 级别 | 文档 | 说明 |
|---|---|---|
| **现状（可依赖）** | `overview.md`（本文）、`status.md`、`cli.md §4.1`、`persona-install.md`、`monorepo.md`、`team.md`、`pricing.md`、`migrations/yan-agent-current.md` | 与代码/本机一致 |
| **设计（部分未实现）** | `architecture.md`、`framework-bootstrap.md`、`entrypoints.md`、`kit-install.md`、`versioning.md`、`patching.md`、`team-automation.md`、`security-sandbox.md`、`dependency-registry.md`、`acp-integration.md`、`proposals.md` | 保留意图，文首/文中标注实现范围 |
| **方向（不是现状）** | `vision.md` | 长期定位：superagent/team 工厂、平台版本经验库、fleet（openrig）边界 |
| **平台经验** | `platforms/index.md` | opencode/dsh 版本矩阵、已知坑、验证命令、脱敏规则（不记录设备） |
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
cd ~/repos/github/dia && bun run test     # 188 tests + smoke + E2E-1
```
