# 版本与多会话（persona / kit）

> 日期 2026-10-28。问题：dia 要支持升级/本地迭代期间不同会话用不同版本 persona；kit 是否也要会话级版本？
> 结论：**persona 硬钉；kit 按类型分**——工具/技能硬钉，知识滚动但记录索引哈希。

---

## 1. 为什么 yan 的做法不够

yan：同一时间只有一个 agent 版本生效，升级 = 覆盖。
问题：
- 升级时在跑的会话会被动切换（或直接坏）；
- 本地迭代无法与稳定版并存；
- 出问题无法回答"这个会话当时用的哪版"。

dia 需要：**多版本并存 + 会话级钉住 + 可追溯**。

---

## 2. 存储模型

```
~/.local/share/dia/
├── personas/<id>/<version>/        # 每个版本完整目录（含 dia.json）
├── kits/<id>/<version>/
├── channels.json                   # stable/dev → 具体版本
└── sessions/<session-id>.json      # 会话钉住的版本与哈希
```

- `version` = `semver+commit`（如 `1.2.0+abc1234`）；
- 内容寻址：同 hash 的目录只存一份（跨版本去重）；
- 保留策略：`gc --keep N`（默认 3），dev 版本可标 `ephemeral` 自动清。

---

## 2.1 semver 判定 + breaking 标记

| 变更 | bump | 例子 |
|---|---|---|
| 移除工具/技能、工具签名变化、策略收紧或放宽、人格身份变化 | **major** | 删除 `bash` 工具、改审批阈值 |
| 新增工具/技能、增量提示词、知识新增 | **minor** | 加 `dsh` 工具、补一条规则 |
| 文档、错别字、非行为修正 | **patch** | 改说明文字 |

- `dia.json` 可显式标 `"breaking": true`（或 `breaking: ["remove-tool:bash"]`）→ 强制 major。
- `dia` 在 `persona update --check` 时**建议版本号**：按 diff 分类给出 `major/minor/patch`，作者确认。
- **硬检查**：实际 bump 不得小于建议级别；否则拒绝发布。

## 2.2 双重审查（硬检查 + 模型）

| 闸门 | 检查 | 失败 |
|---|---|---|
| **硬检查（dia）** | schema、semver、hash、文件白名单、capabilities 是否扩大、secret 扫描、依赖约束 | **拒绝** |
| **模型审查** | diff 是否削弱策略/引入注入/与 persona 意图冲突；给 verdict + 证据 | 标记 `needs-human`，人批 |

模型**不能推翻硬失败**；硬检查**不替代**语义审查。

## 3. 会话钉版本

会话开始时解析并写入：

```json
{
  "session_id": "...",
  "persona": { "id": "dabo", "version": "1.2.0+abc1234", "hash": "sha256:..." },
  "kits": [
    { "id": "core", "version": "1.2.0+def5678", "mode": "pinned" },
    { "id": "knowledge", "index": "idx-2026-10-28T10:00Z", "mode": "rolling" }
  ]
}
```

规则（基线）：
- **persona：默认硬钉**；是否允许"增量补丁"取决于宿主能力（见 §3.1）。
- **工具/技能 kit：默认硬钉**；增量新增可被感知，移除/签名变化需要新会话或 `in-history` 能力。
- **知识 kit：滚动**，但**每次检索记录索引版本/hash**；eval/canary 场景可强制硬钉。
- 没有记录 = 无法判定，审计直接标 `unknown`。

### 3.1 能力分级（决定"能感知到什么"）

| 级 | 能力 | 代表 | 能做什么 |
|---|---|---|---|
| **T0** | 无钩子 | 纯 CLI、无事件 | 只能下次会话生效 |
| **T1** | 工具边界 | MCP 状态、工具报错 | 下次工具调用时感知（如"需要登录"） |
| **T2** | 事件/预步 | dsh `tools/change`、`llm/adapters-updated`、`agent/pre-step`；opencode `event.subscribe`、`session.hook` | 下一轮模型请求前注入通知 |
| **T3** | 原生增量更新 | dsh `toolUpdate=addition-only/in-history`；opencode `agent.transform` | 增量工具/定义可在会话内生效 |

**关键差异（dsh 实测）**：
- `addition-only`：新增工具以 tool-addition 块跟随缓存，**移除不通知**；
- `in-history`：新增 + 移除都进历史，能感知移除；
- 缺省：每次请求重写完整工具表（缓存失效）。

### 3.2 变更类型 × 能力 → 动作

| 变更 | T0 | T1 | T2 | T3 addition-only | T3 in-history |
|---|---|---|---|---|---|
| 知识更新 | 下次会话 | 下次检索 | 下次检索 | 下次检索 | 下次检索 |
| **新增工具** | 下次会话 | 下次调用 | 注入通知 | **原生追加** | **原生追加** |
| **移除工具/签名变化** | 下次会话 | 报错 | 通知 + 拒绝调用 | **下次会话**（不通知移除） | **原生移除 + 拒绝** |
| persona 增量补丁 | 下次会话 | 下次调用 | **注入补丁通知** | 原生更新（若支持） | 原生更新 |
| persona 换身份 | 下次会话 | 下次会话 | 下次会话 | 下次会话 | 下次会话 |

**原则**：用当前会话能安全支持的最强动作，而不是一律降级；**破环性变更永远不静默热切**。

**H19 实测（2026-10-28，opencode 2.1.3）**：
同一 ACP 会话，`h19probe` agent 文件从 v1 改为 v2 后，第二轮仍返回 `H19-V1`；
模型 reasoning 原文："The system update didn't change my identity."
→ **persona 身份在会话内被钉住**；next-session 默认正确。
（dsh 源码级一致：profile/bundle 启动时加载，headless HMR 关闭。）

**H17 实测（`projectToolUpdates`，2026-10-28）**：
给定历史 `a,b`、新增 `c`、移除 `a`：

| 模式 | 工具声明 | 历史块 |
|---|---|---|
| `addition-only` | `b, c(deferred)` | 只有 `tool-addition:c`（**移除 a 不通知**） |
| `in-history` | `a, b, c(deferred)` | `addition:c` + `removal:a` |
| 缺省 | `b, c` | 无 developer 消息（每轮重写全表） |

→ **新增工具可在会话内公告；移除只有 `in-history` 能感知**。

---

## 4. 通道（channel）：稳定版与迭代版并存

```json
// channels.json
{ "dabo": { "stable": "1.2.0+abc1234", "dev": "1.3.0-dev+fedcba9" } }
```

- `stable`：日常入口，用户的默认选择；
- `dev`：本地迭代，只给开发者/测试用；
- 宿主侧映射：
  - opencode：`dabo`（stable）与 `dabo-dev` 两个 agent 文件；
  - dsh：`dabo`（stable）与 `dabo-dev` 两个 profile。
- 这样升级 stable 时，dev 可以继续跑，互不影响。

---

## 5. 激活规则

| 动作 | 行为 |
|---|---|
| `persona update` | 新版本落盘；按 `activation` 模式决定是否切 active |
| `persona activate dabo@<ver>` | 切 stable 指针；有活跃会话时按能力分级：T3 增量可 `--apply active`，破环性变更要求 0 活跃 |
| `--activate-now --i-am-human` | 强制切；运行中会话仍用旧版（宿主不热更） |
| `persona gc --keep 3` | 清理旧版本；被会话引用/被 pin 的跳过 |
| `persona rollback dabo` | 切回上一 stable（同 activate 规则） |

---

## 5.1 生效时机：用户选择并记住

配置存 `~/.config/dia/activation.yaml`：

```yaml
dabo:
  mode: next-session        # next-session | active-additive | active-all | manual
  notify: true
  confirm_breaking: true
```

| 模式 | 行为 | 适用 |
|---|---|---|
| **next-session**（默认） | 只切指针；运行中会话保持旧版 | 日常升级 |
| **active-additive** | 只把"增量变更"推给活跃会话；破环性变更排队 | 加工具/加知识 |
| **active-all** | 尝试全部生效；破环性需 `--i-am-human`；可能迁移/重启 | 紧急修复 |
| **manual** | 只落盘；用户逐会话 `dia persona apply` | 保守/调试 |

命令：`dia persona activation dabo --mode active-additive`（记住）。

## 5.2 "所有会话立即用最新"能怎么做

| 方式 | 保证 | 代价 |
|---|---|---|
| **增量注入**（T3） | 新增工具/补丁在下一轮生效 | 只支持增量；不覆盖破环 |
| **会话迁移/fork** | 用新配置重建会话，保留上下文 | 依赖宿主 fork/resume；一次一会话 |
| **重启宿主 daemon/profile** | 所有新会话必用新版；在跑会话中断 | 破坏性；仅 `active-all` 且人批 |
| **标记 stale + 提示新建** | 不中断，用户自己换 | 用户需操作 |

**没有"对运行中会话无损、全量、立即"的通用方案**；必须在上面四选一。

## 6. 通知（热切必须提示）

任何对活跃会话的变更都要注入提示（能注入时）：

```
[dia] persona dabo 1.2.0 → 1.3.0
变更：新增 web 工具；排障口吻调整
生效：下一轮 / 需新会话
```

- 注入点：dsh `agent/pre-step`；opencode `session.hook("context")`；
- 不能注入（T0/T1）→ 在下一次工具结果或 `dia status` 中提示；
- 同时写审计（`persona_switched` 事件，含 session/old/new/reason）。

## 7. 宿主限制（必须写清）

- **dsh**：profile 在进程启动时加载；多版本靠**多 profile**（`dabo` / `dabo-dev` / 可选 `dabo-<ver>`），不能在一个进程里换。
- **opencode**：agent 文件按 id 加载；多版本靠**多 agent id**（stable/dev），不能同一个 id 两个版本。
- dsh：`toolUpdate` 模式决定增量能力（`addition-only` 不感知移除；`in-history` 可感知）；profile 本身仍需重启。
- opencode：MCP 状态实时（`mcp list` 可见）；agent 目录可由 `reload`/`agent.transform` 更新，但会话快照是否切换需探针（H17）。
- **不做无差别的"一律热更"**：破环性变更（移除工具/换人格）永远要求新会话。

---

## 8. UX

```
$ dia persona list dabo --versions
1.2.0+abc1234  stable   active sessions: 1
1.3.0-dev+fed  dev      active sessions: 2

$ dia persona activate dabo@1.2.0+abc1234
refused: 3 active sessions; use --activate-now --i-am-human or wait

$ dia session show ses_xxx
persona dabo@1.2.0+abc1234
kits core@1.2.0+def (pinned), knowledge@idx-2026-10-28T10:00Z (rolling)
```

---

## 9. 待确认

1. **知识 kit 的默认策略**：滚动 + 记录索引哈希（推荐）vs 会话硬钉。
2. **多版本宿主映射**：stable/dev 双通道（推荐）vs 每版本独立 agent id / profile。
