# dia msg 2.0：多会话协作的需求 grill

> **一句话**：把会话变成一等协作对象——可寻址、可投递、有义务、有依赖、可观测；v1 只做 M0 送达与可读。
> 日期：2026-11-05 ｜ 状态：**需求分析（已确认 v1 = M0 送达与可读；设计见 `docs/msg-collab-m0-design.md`）**
> 决策记录：2026-11-05 用户拍板「只做 M0 送达与可读」，红队推荐被采纳；M1+ 以 M0 两周真实使用为前置。
> 方法：现状取证（仓内代码 + 本机数据 + 今日会话）＋ OpenRig 公开文档对照 ＋ 两队独立复核
> 证据口径：标「实测」的来自本机命令/文件；标「推断」的来自标题、命名或文档推理，不可当事实用。

---

## 0. 结论先行

**今天的真实协作通道不是 `dia msg`，是手写 inbox 文件。**

- `~/.dia/msg` 只有 4 条消息，全部 `pending`，0 条 ack/reply；两条“收件人”的名字是**会话标题**
  （`session-1`、`dws-hub 实时链路修复（…）`），不是稳定地址（实测）。
- `dia agents list` 为空、`~/.dia/agents` 不存在；没有任何会话在启动时注册自己（实测）。
- 今天 15:00 后仍有 12 个会话在跑，全部共用 `~`，其中 ≥4 个会话在动 dia 仓（推断，按标题）。
- 真正跨会话的约定发生在 `<agent-data-root>/inbox/to-agent-a.md`、`to-node-b.md` 这类手写 Markdown 里：
  谁改哪个路径、谁让路、`STATUS: done` 信号——**这些字段 `dia msg` 都没有强制表达**（实测）。

因此需求不是“给 msg 加 from/to 字段”（信封里其实已有 from/to），而是：

> **把「会话」变成一等协作对象：可寻址、可投递、有义务、有依赖、可观测；文件邮箱只是持久化底座，不是产品面。**

建议采用 **三层模型 + 可选 hub**：

| 层 | 内容 | 解决今天哪个痛 |
|---|---|---|
| **L1 身份与通道** | 会话注册/心跳、稳定地址、正文内联、宿主适配投递、收件箱在回合开始时注入 | 消息没人读、收件人靠会话标题、正文在临时目录 |
| **L2 义务与依赖** | work item（owner/状态/依赖/交接/关闭原因，落地为扩展 `dia task`）、共享热点 claim、依赖边、交付≠验收 | 并发改同一仓、先后顺序靠人喊、review 靠记忆 |
| **L3 图与观测** | 从 L1/L2 事实派生依赖图，TUI/Web 只读展示；attention 队列 | 没有仪表盘，任务关系只在脑子里 |

**不照搬 OpenRig 的“常驻席位 + snapshot/restore 全家桶”**；借它的**地址语义、队列收口、交付≠验收、逐席诚实结果**即可。
**不要先做 daemon**：先把身份/义务/图的数据契约做实，daemon 与多机是可选加速层（见 §7、§9）。

### 0.1 红队评审后的修订（v0.2，重要）

初稿被红队按“会不会做完没人用”反驳后，以下结论已改：

1. **第一瓶颈是“读”，不是“依赖/图”**：4 条消息 03:45–08:04 发出，16:00 仍全 pending，而收件会话今天还活着。
   ⇒ v1 只做「会话开始自动读到未读」+ 正文内联 + 收工未读告警；L2/L3 以 M0 被真实使用为开工前置。
2. **不新建第三张任务表**：`dia task` 已有 `judge/evidence` 与 `awaiting_acceptance/accepted`（交付≠验收已存在），
   ⇒ 只扩字段（owner/deps/touches/closure_reason），宿主 `todo` 是执行态、`dia task` 是义务态，不再造 `WorkItem` 表。
3. **租约不做“同 worktree 单写者”**：真实冲突是 `install.sh`/`launchd` 这类共享热点，agent 改文件不经过 dia；
   ⇒ 降级为**共享热点文件 claim + 告警**（不排队），强制点放 pre-commit / MR 模板。
4. **身份 v1 只认宿主 session id**：`role@project` 别名推迟；别名解析失败必须报错，不静默排队。
5. **多机/daemon 推迟**：跨机真实协作为 0、SSH 未验证；先验证宿主自带注入（opencode `session_inbox`/`steer`、`schedule`）能否复用。
6. **要有回滚判据**：两周内执行过 `dia in` 的会话 <30% ⇒ 回滚到「手写 inbox + 硬规则」，不硬撑。
7. **框架能力 vs agent 内容**（2026-11-05 用户校正）：协议/存储/CLI/宿主适配器归 **dia 框架**；
   `msg` 作为 **dia 默认 kit** 随每个 agent 安装（何时/怎么用也在 kit 里），默认开启、可显式关闭；
   example-agent 只做额外强化，不承载插件/适配器代码。

---

## 1. 今天发生了什么（证据）

### 1.1 并发是常态，不是例外

`session_v2` 实测（2026-11-05 15:00 后仍活跃的顶层会话）：

| 会话标题 | 目录 | 最后活动 |
|---|---|---|
| session-1 | `~/` | 16:03 |
| session-2 | `~/` | 16:03 |
| session-3 | `~/` | 16:03 |
| session-4 | `~/` | 16:03 |
| session-5 | `~/` | 16:03 |
| session-6 | `~/` | 16:02 |
| session-7 | `~/` | 16:01 |
| session-8 | `~/` | 15:47 |
| session-9 | `~/` | 15:40 |
| 切换到 retro-library 工作目录 | `…/retro-library` | 15:39 |
| PDD_AI_QA 店铺入口登录态丢失 | `…/eval/tasks/entry` | 15:38 |

- 15:00 后 **12 个会话共用 `~`**；全天该目录 33 个会话（13 个顶层）（实测）。
- 同一时刻至少 4 个会话在动 dia 仓（推断，按标题）：数据根/安装拆分、persona 目录、`dia wt adopt`、本需求。
  其中“数据根迁移 → 安装脚本拆分”是**真实的前后依赖**：`to-node-b.md` 明确写了“我让路/别碰哪些文件”，
  但这是人手写约定，不是机器可检查的依赖（实测文件内容）。
- `dia msg` 的 4 条消息正好对应这些协作：一条 handoff（service 名词提案）、一条进度同步、
  一条时序问题（“我该等还是继续装 review 服务？”）、一条 dws-hub 迁移提醒——**全部停在 pending**（实测）。

### 1.2 手写 inbox 已经承担了协作协议

`<agent-data-root>/inbox/to-node-b.md` / `to-agent-a.md` 里有这些字段（实测）：

- `STATUS: done @ 2026-11-05T16:00+08:00`
- “我当前进度 / 会碰的文件 / **不会碰**：… / 冲突面提醒：如果你也要改 install.sh 请先在这里写一行，我让路”
- “你可以 / 不要 `dia persona add/update yan` / 如果脚本写死了旧路径请改…”

这些正是 `dia msg` 缺的东西：**路径级冲突面、让路声明、完成信号、对我方的约束**。
现在它们只存在于自由文本里，无法被查询、无法被图工具消费。

### 1.3 现有 `dia msg` 的硬缺口（实测，文件:行）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **无会话身份**：`from` 来自 `--from`/env，不从会话推导；注册表为空；收件人是会话标题 | `packages/cli/src/index.ts:556`；`dia agents list` → `(none)`；`~/.dia/agents` 不存在 |
| G2 | **无可用投递**：tmux 未安装；ACP 只 `session/new`（新开 headless 会话，接不进正在跑的 TUI）；codex 无 ACP | `src/tmux.ts:37-71`；`src/msg-acp.ts:31`；`src/acp.ts:59` |
| G3 | **正文不可靠**：`--body-file` 只存路径，`show` 只打印“(见文件) 路径”；4/4 条正文都在系统临时目录 | `src/msg.ts:122`；`packages/cli/src/index.ts:599`；4 条 `body_file` 均在 `/private/var/folders/.../T/opencode/` |
| G4 | **无闭环**：`closed` 状态没有任何生产者，邮箱只增不减；没有 `close`/archive/GC | `src/msg.ts:18,143`；全仓无写入点 |
| G5 | **并发不安全**：幂等键 `thread_id#seq` 由“现存最大 seq+1”算出且调用方不能指定；状态读-改-写无锁；排序用 `created_at` 字符串 | `src/msg.ts:106-111,160-167,195-198,79,206` |
| G6 | **无义务模型**：`dia task` 无 owner/依赖/交接/关闭原因；`dia team` 四角色写死且一次性；`dia wt` 无租约/锁 | `src/task.ts:10-19`；`src/team.ts:19`；`packages/wt/bin/dia-wt`（grep lock/owner 无命中） |
| G7 | **无观测**：没有 graph/dashboard；`stuck` 阈值写死 30min；`dia msg agents` 只是列目录，语义误导 | `src/msg.ts:249,256`；`dia msg --help` 与实际命令不一致（漏 show/status/stuck/deliver/needs-info） |
| G8 | **多机为零**：msg 根是本地 `~/.dia/msg`；无节点 ID、无同步/合并/时钟处理 | `src/paths.ts:13-19`；全仓无同步代码 |

### 1.4 采用率问题（用户点名的“小问题”）

- yan persona / dia 文档里几乎没有 `dia msg` 的用法（`grep "dia msg" core/ knowledge/` 只在角色设计文档出现，实测）；
  agent 没有“开工先收件、收工发交接”的默认动作，自然用手写文件。
- `dia team` 有能力（planner/builder/verifier/redteam + gate），但**没有被默认触发**；
  `docs/team.md` 自己也写“现在不是团队，是一个人 + 临时工”（实测）。
- 结论：**通道再好，没有“默认动作 + 低成本调用”就不会被用**。需求里必须有“入口”而不是只做底层协议。

---

## 2. OpenRig 对照（公开文档取证）

> 来源：openrig.dev（what-is / rigspec / coordination / messaging / workflows / tui / continuity / edge-types / hosts-and-humans / guides/multiple-machines）。文档明确项已标注，推断另列。

### 2.1 概念映射

| OpenRig | 定义 | dia 现状 | 可借/不可借 |
|---|---|---|---|
| **rig** | YAML 声明的多 agent 拓扑，up/down/snapshot/restore | 无；`dia team` 是一次性 run | 借“拓扑是声明式、可检查的” |
| **pod** | 共享上下文/启动文件的组，但每 agent 独立 context window | 无常驻组；子 agent 即用即走 | 借“共享启动上下文”，不借“常驻 pod” |
| **seat** | `pod-member@rig` 的持久身份位；session 会结束，seat 不会 | 无席位；会话就是一切 | **借地址语义**：逻辑地址 + 当前占用者（见 §5.2） |
| **session** | 一次 harness 执行 | opencode `ses_*`，有 directory/title | 应成为一等对象 |
| **queue item** | 有 owner 的义务行，claim/close/handoff，历史只追加 | `dia task` 近似但无 owner/依赖/交接 | **重点借** |
| **edge** | `delegates_to/spawned_by/can_observe/collaborates_with/escalates_to` | 无 | 借语义，裁剪到 dia 需要的 4 种（§5.4） |

### 2.2 通信机制（文档明确）

- `rig send`：单 seat / 多 seat / `--pod` / 整 rig；向对方 prompt 打字并带 From/To 信封；
  **消息不留义务**，需要对方行动必须建 queue 行。
- `rig chatroom`：rig 级、带 topic、**持久化到 DB**，可 history/wait/watch；与 send 的“打字”不同。
- `rig broadcast`：整 rig/整 pod 群发；同样受 typing guard / 交互提示保护。
- **typing guard**：人正在打字的 seat 会 hold 自动消息，读但不投；默认关闭。
- `--verify` 只证明“文本出现在 pane”，不证明对方理解（作者自己承认）。

**对 dia 的启示**：消息与义务必须分开（inform vs obligate）；持久化聊天室比“直接打字”更适合跨会话；
投递成功 ≠ 理解，不能拿 `send-keys` 退出码 0 当 delivered（dia 设计文档已写，但实现里仍以“文本含 id”为准）。

### 2.3 义务与依赖（文档明确）

- queue 状态：`pending → in-progress → done/blocked/failed/denied/canceled/handed_off`；transitions 只追加。
- **close 必须给 closure reason**（`handed_off_to/blocked_on/denied/canceled/no-follow-on/escalation`）；
  规则在 DB 事务内强制，防止“无理由完成”。
- **handoff 是一个事务**：源行关闭 + 新行给 `--to`；不留下悬空工作。
- **delivery ≠ acceptance**：closure 只记“已交付”，验收是下一环节对自己那一行的裁决。
- `stream`（只追加观察，不需行动）／`view`（状态投影：held/escalations/pickup/pod-load）／`project`（观察→分类去重的行）。
- workflow：step 关闭时**同一事务**创建下一步的 queue 行；失败/超时升级给 orchestrator；watchdog 持久化调度。
- 拓扑排序有环即 `cycle_error`；**边不负责路由消息、不控权限**，只约束启动顺序/表达意图。

**对 dia 的启示**：`dia task` 应从“todo 台账”升级成“有 owner 的义务行”，并强制终态码；
消息只做通知，行动必须生成/交接 work item；否则消息会变成“已读不回”的噪音。

### 2.4 会话管理（文档明确）

- `discover` 扫未托管 tmux；`adopt --bind logicalId=session` 一步绑定；`release/unclaim` 放手不杀进程；`reconcile-session` 认回手工 resume。
- `rig down --snapshot` 尽力快照；`restore-check` 退出码 0/1/2；恢复逐 seat 报
  `resumed / fresh / awaiting-decision / attention_required / failed`——**不把失败抹成成功**。
- `continuity_policy` 在 0.6.6 **只校验/存储，无人执行**（文档自认）。
- seat 与 session 分离的落地动作是 `handover`：create → 交付 context → 验证连续性 → rebind。

**对 dia 的启示**：dia 的“按需拉起”不需要常驻席位，但需要**“逻辑地址 → 当前会话”的绑定**与**认领/释放**；
会话结束/崩溃时，地址上的未完成义务要能被下一个 occupant 接走（handover），而不是消失。

### 2.5 多机（文档明确）

- 每机一个本地 daemon（HTTP + SQLite），pair 后成 fleet；地址形如 `member@rig@host`。
- **“一个团队不能跨机成为同一个 rig”**；不同步仓库、凭据、登录、agent context。
- 跨机 queue 只有 create/handoff；show/claim/list/update 只在持有该行的机器上。
- 跨机 handoff 不能跨两个库：先建后继再关本地；中断可能留重复，由重试吸收（at-least-once + 确定性 successor id）。
- **state 合并/双向同步/多 daemon 共识：未找到公开证据**。

**对 dia 的启示**：不要做“全局一致的多机状态合并”；做**单写者 + 事件转发**：
每个节点拥有自己的 inbox/work item 写入权，跨节点只做消息投递与 handoff；冲突用确定性 id + 重试吸收。

### 2.6 不该照搬的

1. **常驻 seat + snapshot/restore/continuity 全家桶**：与 dia“按需拉起、会话即用即走”相反；连上游都承认 continuity 无执行者。
2. **tmux 打字当信道**：capture 自称“尾窗、不保证没漏”；dia 子 agent 有结构化返回，不应依赖读屏。
3. **五条边全实现**：dia 没有固定启动顺序，`spawned_by/delegates_to` 的大部分语义用不上；先实现有消费方的边。

---

## 3. 需求点目录（grill 产出）

> 优先级：P0 = 不做就无法采用；P1 = 影响正确性/返工；P2 = 体验与扩展。
> 每条给“最低可接受行为”与“判据”，避免“做了个界面 = 完成”。

### A. 采用与入口

| ID | 需求 | 最低可接受行为 | 判据 |
|---|---|---|---|
| **A1** | 会话默认收件 | 会话启动/每回合开始时，宿主适配器把未读消息注入上下文（或至少提示“有 N 条未读”），不依赖人记得敲命令 | 两个真实宿主会话互发后，无需手动命令即可看到；漏读率可测 |
| **A2** | 默认交接动作 | 开工/收工模板内置：注册、领任务、声明改动的路径、发 handoff、关任务 | 新建会话 1 分钟内出现身份+作用域；收工有终态 |
| **A3** | 子 agent/团队默认触发 | 当任务满足“可拆分/需独立验证/高风险”时，入口主动建议 `dia team` 或子 agent，而不是靠 agent 自觉 | 固定 10 例语料（5 应触发/5 不应）≥8/10 通过，语料入库 |
| **A4** | 低成本命令 | 一条命令完成“我是谁/我在做什么/谁在动这个仓” | `dia whoami`、`dia status --repo` 可用 |
| **A5** | 读的强制点 | 会话开始自动读未读；收工有未读且未声明忽略时打显式 warning（不阻断）；框架默认规则 | 连续 5 个真实会话无需提示即可看到未读；收工漏读可被检出 |
| **A6** | 默认能力包 | `dia-msg` 是框架默认 kit：所有 dia agent 默认带 skill（何时/怎么用），不靠 persona 自己声写；可全局或按 persona 关闭 | 新建 agent 装完即能在 skill 列表看到 `dia-msg`；关闭后 `status=disabled` 且手动命令仍可用 |

### B. 身份与通道

| ID | 需求 | 最低可接受行为 | 判据 |
|---|---|---|---|
| **B1** | 会话身份 | 稳定 `session_id`（宿主+会话 id）、显示名、host、pid、cwd、project、worktree、git HEAD、roles、能力、心跳 | 注册表可列出所有活会话；重启后旧记录标 stale 而非假装在线 |
| **B2** | 稳定地址 | 支持 `session:<id>`、`role:<role>@<project>`、别名；地址解析到“当前占用者”，无占用时排队 | 用中文标题也能寻址；地址冲突/过期有明确错误 |
| **B3** | 全信封可见 | from/to 不仅存 JSON，`show`/注入文本/图里都带 `from{node,session,role}`、`to`、`thread`、`refs`、时间、回复方式 | 收件人只读一条消息就能知道是谁、为什么、回哪里 |
| **B4** | 正文持久 | `--body-file` 发送时复制进消息存储（内容寻址或 `bodies/<id>`），`show` 内联；原文件删除不影响 | 删除源文件后 `show` 仍完整；迁移/备份可复现 |
| **B5** | 投递适配 | opencode（插件/HTTP/ACP）、dsh（ACP）、codex（ACP/exec）、tmux 兜底；失败显式降级并记录原因 | 每个宿主至少一条真实链路；失败不静默；**不可注入的宿主显式标 `unaddressable`，不无限排队** |
| **B6** | 生命周期 | `close`/`archive`/TTL/GC；终态必须给原因；`stuck` 可配置并接调度 | 邮箱不会无限增长；关闭后不可再被 reply 唤醒（除非 reopen） |

### C. 义务、并发与依赖

| ID | 需求 | 最低可接受行为 | 判据 |
|---|---|---|---|
| **C1** | work item 一等 | owner、状态机、依赖、交接、关闭原因、验收者、证据；`delivery ≠ acceptance`；**扩展现有 `dia task`，不新建表** | 任意任务可回答“谁负责、卡在哪、谁验收”；`todo` 与 `task` 的映射规则写进文档 |
| **C2** | 共享热点 claim | 对 `install.sh`、`AGENTS.md`、`launchd/` 等热点文件做 `claim`（追加 JSONL）；开工时打印他人 claim 作告警；不排队、不阻断；强制点放 pre-commit/MR 模板 | 两会话同时声明同一热点时，第二个会话看到告警；未声明热点的提交被 pre-commit 提示 |
| **C3** | 依赖声明与推导 | 显式 `depends_on/blocks`；从 task、worktree、diff 路径、消息 refs 推导候选边；环检测 | 依赖图能画出今天的“数据根→安装脚本→launchd”链 |
| **C4** | 交接与评审 | handoff 原子关闭+新建；跨会话 review 请求是义务（有 owner/deadline），不是通知 | 交接后无悬空；review 未完成不能被标记 done |
| **C5** | 协调者（无常驻） | 需要时选举/认领一个协调会话，负责排序、催办、升级；默认只建议不强制 | 协调者宕机后义务不丢；人工可接管 |

### D. 图与观测

| ID | 需求 | 最低可接受行为 | 判据 |
|---|---|---|---|
| **D1** | 图数据契约 | 节点：session/task/work item/repo/worktree/host/MR；边：depends_on/blocks/reviews/touches/spawned_by/informs；每条边标 declared/inferred + 置信度 | `dia graph --json` 可被第三方消费 |
| **D2** | TUI | 拓扑/队列/冲突/attention 四视图；键盘操作；刷新不闪烁 | 12 个会话 + 依赖边可读；阻塞项一眼可见 |
| **D3** | Web（可选） | 只读 + SSE/轮询；跨节点只读汇总；移动端可看 attention | 不开本地端口也能通过 SSH 隧道看 |
| **D4** | 事实与推断分离 | 图不得把推断边显示成事实；点击节点能追到证据（文件/命令/消息） | 推断边有标记；证据可回源 |

### E. 多机（本机 + node-b）

| ID | 需求 | 最低可接受行为 | 判据 |
|---|---|---|---|
| **E1** | 跨节点寻址 | `session@node` / `role@project@node`；节点注册、心跳、能力 | 本机可向 node-b 发消息并收到 ack |
| **E2** | 离线队列 | 目标离线时消息落 outbox，上线后补投；幂等去重 | 断网 50 条，恢复后不重不漏 |
| **E3** | 状态合并 | 单写者事件日志 + Lamport/节点 id 排序；work item 只在 owner 节点可写；handoff 用确定性 id | 分区两侧各自推进后合并，无覆盖、无重复 |
| **E4** | 传输 | 默认 SSH store-and-forward（复用现有免密/隧道）；可选 hub  federation；不依赖共享文件系统 | 无公网、GitHub 不通的 node-b 也能工作 |
| **E5** | 安全 | 消息正文=数据不是指令；节点间认证；敏感字段不入图/日志/URL；env 红线不破 | 注入测试不执行消息内指令；图里无凭据 |

### F. 兼容与迁移

| ID | 需求 | 最低可接受行为 | 判据 |
|---|---|---|---|
| **F1** | 文件邮箱仍可用 | daemon 不在也能收发；数据格式可读、可手改 | 单机无服务时全流程可用 |
| **F2** | 旧数据迁移 | 现有 4 条消息可读；agent 目录名映射为 alias | 迁移脚本幂等；旧消息不丢 |
| **F3** | 单一事实源 | 不复制 task/owner 状态到多处；图是投影 | 同一问题只有一个答案 |

---

## 4. 关键设计选择（带推荐）

### 4.1 身份：session 还是 seat？

| 方案 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| 纯 session id | 精确、无歧义 | 人不可读；会话重启即失效；无法表达“这个角色” | 底层引用 |
| 纯 role/seat | 可读、稳定 | 与 dia“按需拉起”冲突；role 抢占/空置复杂 | 长期团队 |
| **混合（v1 只做底层，别名后置）** | `session:<id>` 是事实；`role:<role>@<project>` 只作**可选别名**，且解析失败必须报错 | 别名需要解析/过期/重名规则 | 长期团队 |

推荐：**v1 只用 `session:<host_session_id>` + `display_name`**（可判定、可校验、可追踪）；
`role@project` 别名等 M1 之后、有真实“找角色”需求再加。**别名解析失败即报错，不排队**——
现有 4 条消息就是“地址存在但没人读”的静默积压样板。

### 4.2 消息 vs 义务

推荐明确分开：

- **message**：inform/ask/reply，最多产生“未读/未回”状态；不承诺有人做。
- **work item**：obligate，必须有 owner；完成必须给终态与证据；可 handoff（实现上扩展 `dia task`，不新建表）。
- **stream**：observe，只追加，不要求行动（今天的“进度同步”多数属于这一类）。
- 规则：`requires_reply=true` 的消息超时 → 自动升级为 work item 或 escalated，不允许沉默消失。

### 4.3 并发控制

推荐 **共享热点 claim + 作用域声明**，不引入全局锁、不做全 worktree 单写者（红队指出：agent 改文件不经过 dia，全 worktree 锁没有执行点）：

1. 会话开工时声明 `repo/worktree/paths`（可先粗后细；`dia wt scope` 已有雏形）。
2. 对 `install.sh`、`AGENTS.md`、`packaging/launchd/` 等**共享热点**做 `claim`（JSONL，带过期时间）；
   开工时打印他人重叠 claim 作告警；**不排队、不阻断**，强制点放 pre-commit / MR 模板。
3. 依赖未满足时，task 进入 `blocked`，图上显示 blocker；不靠人记忆。
4. 冲突不自动合并代码：只做“谁先谁后/谁让路”的协调，代码合并仍走 MR。

### 4.4 依赖图的边（裁剪）

| 边 | 语义 | 来源 | 是否阻塞 |
|---|---|---|---|
| `depends_on` | A 完成前 B 不能开始 | 显式声明/任务拆解 | 是 |
| `blocks` | 反向投影（由 depends_on 派生） | 派生 | 是 |
| `touches` | 改同一 repo/worktree/路径 | 作用域声明 + diff | 警告/租约 |
| `reviews` | A 的产出需 B 评审 | review 请求/work item | 是（验收前） |
| `spawned_by` | 子 agent/子任务 | 运行时 | 否（仅溯源） |
| `informs` | 仅通知 | 消息 refs | 否 |

**不实现** `can_observe/collaborates_with` 这类无消费方的边，等有视图/权限需求再加。

### 4.5 常驻服务：要不要 daemon？

**v1 不引入 daemon。** 先验证宿主自带能力：

- opencode DB 已有 `session_inbox`（`delivery=steer`）与 `schedule` 表（实测 schema），
  理论上可在回合内注入/定时唤醒；先在半天内验证能否注入任意文本，能通则 B5 的适配面大幅缩小。
- 文件邮箱仍为事实源；命令直接读写，无服务也能全流程可用。
- 只有当“跨机转发/低延迟唤醒/多宿主统一 presence”出现真实需求时，才加 `dia hub`（socket 激活、可缺省）。
- daemon 只做**投递/唤醒、presence、跨节点转发**，不做唯一事实源、不做 LLM 调度。
- 这与 dia vision“不自建运行时/通道”的边界需要一次明确确认（见 §9 Q1）。

### 4.6 多机状态合并

推荐 **每节点单写者 + 追加日志 + 确定性 id**：

- 每条事件：`{event_id, node_id, lamport, actor, type, payload, idempotency_key}`；只追加，不原地改。
- 消息不可变；状态转换是事件；投影可重建。
- work item 的 owner 节点是唯一写者；handoff 跨节点用 at-least-once + 确定性 successor id（吸收重复）。
- 排序用 `(lamport, node_id)`，墙钟只做展示；不信任跨机时钟。
- 同步：SSH `store-and-forward`（默认）→ 可选 hub 联邦；不做共享目录（锁/时钟/覆盖问题）。
- 冲突策略：同一 work item 双写 → 以 owner 节点为准，另一方进 `pending_reconcile` 给人看；不静默 LWW 覆盖。

---

## 5. 数据模型草案（供设计阶段细化）

```text
Node      { node_id, hostname, platform, last_seen, capabilities[] }
Session   { session_id, node_id, host, host_session_id, display_name, pid,
            cwd, project_id, worktree, branch, head, roles[], status,
            started_at, last_seen, parent_session_id?, current_item? }
Alias     { address, kind: session|role|project|team, target, occupant?, ttl }
Message   { id, thread_id, seq, from: ActorRef, to: ActorRef, kind,
            subject, body_ref|body, refs{}, requires_reply, deadline,
            hops, state, idempotency_key, created_at, ack_at, reply_to,
            transport, degraded_reason }
WorkItem  ≡ 扩展后的 dia Task（**不新建第三张表**）
Task      { id, title, owner, state, deps[], touches[], judge,
            acceptance, evidence[], closure_reason?, history[],
            created_by, created_at, updated_at }
Lease     { scope: path, holder_session, expires_at, reason }   // 仅共享热点，不覆盖整个 worktree
Event     { event_id, node_id, lamport, actor, type, payload, ts } // M4 多机时引入；v1 用文件状态即可
```

关键约束：

- `Message.state` 转换只能追加事件，不能丢历史；`closed` 必须有 `closure_reason`。
- `WorkItem` 完成必须有 `acceptance` 与 `evidence`（复用现有 `judge` 思路）。
- `touches` 的路径必须规范化（realpath/相对仓根），否则租约形同虚设。
- 所有投影（TUI/Web/`--json`）从事件/文件重算，不单独维护状态。

---

## 6. 图与 TUI/Web 的产品形态

### 6.1 视图

| 视图 | 回答的问题 | 数据源 |
|---|---|---|
| **Topology** | 现在有哪些会话/项目/节点，谁在动什么 | Session + Alias + Lease |
| **Queue/Board** | 哪些义务在 todo/doing/blocked/review，谁负责 | WorkItem |
| **Dependency graph** | 谁挡着谁，关键路径是什么 | WorkItem deps + touches |
| **Conflicts** | 哪些会话改同一 worktree/路径，谁该让路 | Lease + touches |
| **Attention** | 需要人决策/超时/升级的事 | escalated/stuck/needs_info |

### 6.2 实现边界

- **先 CLI/JSON**：`dia graph --json` 是契约；TUI/Web 只是消费者。
- **TUI**：优先复用宿主 TUI 能力还是自研？建议独立轻量 TUI（读 JSON + 文件监听），不绑定 opencode。
- **Web**：单页 + SSE，只读；默认只监听 127.0.0.1；跨机通过 SSH 隧道。
- **不做的**：实时编辑代码、替代 GitLab MR、替代 CI、复杂权限矩阵。
- **性能**：12 个会话/几十条义务不需要数据库；超过 ~1k 事件再考虑 SQLite 投影（现有 `src/sqlite.ts` 可复用）。

### 6.3 与 nx 的类比

nx 的图是“项目/文件依赖 + 受影响范围”；dia 的图是“会话/义务/改动范围”。
共同点：**节点、边、受影响集合、可视化**。差异：dia 的边有“人/会话”维度，必须区分
**声明依赖**（可靠）与**推断冲突**（启发式），并在 UI 上分色显示。

---

## 7. 里程碑（建议）

> 每个里程碑都必须有可执行判据；没有判据不开工（沿用 team 门禁）。
> **顺序原则（v0.2）**：先把“读”打通并证明被使用，再建义务/图；没有 M0 的真实使用数据，M1 之后不立项。

| 里程碑 | 内容 | 判据（可执行） | 依赖 |
|---|---|---|---|
| **M0 送达与可读（唯一优先）** | 会话身份=s宿主 session id、正文内联、`show` 全信封、收工未读告警、AGENTS.md 硬规则、`dia in`/`dia out` | 两个真实宿主会话互发：无手动命令可见；删源文件后正文仍在；收工漏读可检出；连续 5 个真实会话执行过 `dia in` | — |
| **M1 共享热点 claim** | `claim`/`release`（JSONL）、开工打印重叠 claim、pre-commit/MR 模板提示；**不做全 worktree 锁** | 两会话声明同一热点，第二个看到告警；未声明热点的提交被提示；claim 过期不阻塞 | M0 + 2 周使用数据 |
| **M2 义务扩展** | 扩 `dia task`：owner/deps/touches/closure_reason；handoff 原子化；`todo`↔`task` 映射 | 任意任务可回答“谁负责/卡在哪/谁验收”；交接后无悬空；非法完成被拒 | M1 |
| **M3 图与 TUI** | `dia graph --json` + TUI 四视图 + attention | 固定 fixture（12 会话/30 边/5 阻塞）首屏零滚动含全部阻塞；推断边分色；脚本断言 | M2 |
| **M4 宿主适配** | 先验证 opencode `session_inbox/steer`；dsh ACP；codex；tmux 兜底；降级矩阵 | 每个宿主一条端到端；不可注入标 `unaddressable`；无 tmux 也能用 | M0 |
| **M5 hub 与多机（可选）** | socket 激活 hub、SSH store-and-forward、Lamport 事件、离线队列 | 本机↔node-b 互发；`DIA_TRANSPORT=drop` 注入断网 50 条，恢复后 60s 内 id 集合相等且恰好一次；分区合并无覆盖 | M4 + 真实跨机需求 |
| **M6 Web（可选）** | 只读 SSE 页面 + 跨节点汇总 | 手机/另一台机器可看 attention；无凭据泄露 | M3 |

**回滚判据**：M0 上线两周后，执行过 `dia in` 的会话 <30% ⇒ 判定“没人用”，回滚到「手写 inbox + 硬规则」，
不继续投入 M1+；把失败原因写回本文。

---

## 8. 风险与反模式

| 风险 | 表现 | 缓解 |
|---|---|---|
| 仪表盘变成事实源 | 状态只存在 UI/内存，崩溃即丢 | 图是投影；文件/事件是事实 |
| 消息风暴 | 每个动作都发消息，agent 被淹没 | stream 与 obligate 分离；限流/摘要；attention 聚合 |
| 假闭环 | 自动 ack、`send-keys` 成功即 delivered | 目标进程 ack + 非自动；传输事实与协议自述分离 |
| 过度编排 | 为了“团队”而常驻一堆 agent | 按需拉起；无常驻席位；协调者只是临时角色 |
| 多机分布式复杂度 | 做全局锁/共识，结果不可靠 | 单写者 + 事件转发；不做全局一致 |
| 推断当事实 | 图把猜测画成依赖 | declared/inferred 分色；可回源 |
| 安全 | 消息正文被当指令执行；跨节点泄露凭据 | 固定模板 + 数据/指令分离；节点认证；env 红线 |

---

## 9. Grill：需要人工拍板的决策轴（按优先级）

> 每条给推荐项；确认后再写设计文档（唯一人工确认点）并拆任务。

1. **Q1 边界**：这套协作核心放在 dia 原生实现，还是做 OpenRig 适配层/混合？
   - 推荐：**dia 原生数据契约 + 可选 OpenRig 导出/适配**；不把调度/沙箱外包给 OpenRig（与 vision 一致）。
2. **Q2 身份模型**：session id / role-seat / 混合？
   - 推荐：**v1 只用 `session:<host_session_id>` + `display_name`**；`role@project` 别名推迟，解析失败即报错。
3. **Q3 第一里程碑**：先解决“送达/可读”还是“并发/依赖”还是“看板”？
   - 推荐：**只做 M0 送达与可读**；M1 起以 M0 两周真实使用为前置。看板跟随数据，不先做 UI。
4. **Q4 daemon**：不引入 / socket 激活 / 常驻？
   - 推荐：**v1 不引入**；先验证 opencode `session_inbox/steer`，不行再考虑 socket 激活。
5. **Q5 多机传输**：SSH store-and-forward / hub 联邦 / 共享目录？
   - 推荐：**SSH 优先**（node-b 无 GitHub 出口）；共享目录否决；等真实跨机 handoff 再做。
6. **Q6 协调权限**：协调者只能建议，还是可自动排序/催办/升级？
   - 推荐：**低风险自动（催办/排序建议/升级），高风险留人（改代码/合并/发布）**。
7. **Q7 数据归属**：扩展现有 `dia task`，还是新建 collab store？
   - 推荐：**扩展现有台账**（`dia task` 已有 judge/evidence/awaiting_acceptance），不新建第二套任务表。
8. **Q8 兼容**：`dia msg` 旧命令/旧数据必须保留多久？
   - 推荐：**至少一个大版本**；旧消息迁移 + 命令别名 + 手写 inbox 三字段（STATUS/不会碰/让路）迁进协议。
9. **Q9 回滚**：两周内 `dia in` 使用率 <30% 怎么办？
   - 推荐：**回滚到硬规则 + 手写 inbox**，把失败写回本文；不硬撑。

---

## 10. 待补证据（不影响结论，但影响设计细节）

- opencode 能否在“回合开始”注入任意文本：**已实测 `session_inbox` 表存在 `delivery=steer`（本机 DB schema）**，
  但“外部写入是否被消费、是否需要重启/唤醒”未验证；这是 M0 的关键实验。
- codex 当前是否有 ACP/headless 注入能力（本机未安装，未验证）。
- node-b 与本机 SSH 连通性、端口/隧道策略（需实测，不能假设）。
- `dia wt scope` 的 `session` 字段目前为 null；把它接上会话 id 的成本（代码已存在雏形）。
- 现有 4 条消息的 agent 目录名 → session id 的映射规则（中文标题、空格、重名）；是否需要人工映射表。

---

## 附：本次 grill 的取证分工

| 角色 | 产出 | 关键结论 |
|---|---|---|
| 现状验证（只读） | 命令面/持久化/身份/投递/关联能力/多机/今日并发 | 8 类缺口；`closed` 无生产者；body_file 在临时目录；tmux/ACP 均接不进现有会话 |
| OpenRig 研究（公开文档） | 概念/通信/队列/边/会话恢复/多机 | 地址语义、queue 收口、delivery≠acceptance 可借；常驻席位/snapshot 不照搬 |
| 红队（对抗评审） | 5 条最强反驳、删/补项、判据攻击 | 先解决“读”；不建第三张表；不做全 worktree 锁；多机/daemon 推迟；给出两周回滚线 |
| 主 agent | 需求目录、方案与判据 | 三层模型 + 可选 hub；先 M0，后义务/图/多机 |

> 下一步：人工回答 §9 的 Q1–Q3（至少），再产出 `docs/specs/msg-collaboration-design.md`（含流程图、状态机、迁移与发布顺序），
> 经确认后拆 todo 进入实现。
