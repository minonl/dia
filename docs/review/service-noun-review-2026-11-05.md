# 设计评审 — service 名词与 healthcheck 契约（2026-11-05）

> 评审对象：[`docs/service-noun.md`](../service-noun.md)（提案，commit `3942536`）。
> 评审者：独立子 agent（只读仓库 / `packages/job` 实测源码，不共享作者上下文）。
> 尺度：找「与既有实现冲突」「契约自相矛盾」「验收不可判」三类问题；口味问题单列。

## A. 结论

**方向通过（有条件）**：名词分层正确（persona / kit / job / service 四层不混轴，「job 是唯一调度」的复用立场与
`docs/review/reuse-review.md` 的闸门一致）；§4「区分进程在 vs 在干活」「不推断业务语义」「degraded 不当 fail」三条反例立得住。

> **后续（rev.2）**：以下「不可实现」判断针对 rev.1（`3942536`）。rev.2 已在
> [`docs/service-noun.md`](../service-noun.md) 逐条回复（§11 修订说明 + §12 check-list）；
> 落地读取接口为 `packages/job/lib/json.mjs` 的 `state-kind <file> <kind>`（按 `kind` 取最后一条，
> 无匹配返回空、exit 0）。下文保留 rev.1 原始评审记录。

**但健康状态机（本案核心）在 rev.1 中不可实现**，原因集中在 5 个**阻塞项**（B1–B5）：
退出码与语义三角、超时消抖自相矛盾、`unknown` 状态不可达、`status` 实时执行判据、新鲜度缺失。
另有 P2 级 7 条、口味 4 条。**建议：阻塞项改完再冻结契约**，其余可与实现同步收。

## B. 阻塞项（必须改，否则契约无法落地）

### B1. 退出码语义三角冲突 —— `degraded` 与 `fail` 不可区分

| 来源 | `2` | `3` |
|---|---|---|
| §4 判据 | **degraded** | fail |
| §3 `contract` 示例 `"exit": "0=ok/2=retry"` | **retry**（= 可重试失败，语义上是 fail 的一种） | 未定义 |
| `docs/cli.md` §3（dia 自身退出码） | **用法错误** | — |
| `packages/job/README.md`「0/1/2/3/4/5（same as yan-task）」 | 参数错 | — |

服务一旦同时声明 `contract.exit` 与 `healthcheck`：一次「2=retry」的业务失败会被 health 读成 degraded；
而 health 读成 degraded 的「依赖落后」在 contract 里又没有码。**同一个码两套含义**，服务作者只能猜。

**建议**：health 判定以 `healthcheck` 的**专用退出码域**为准（health 子命令固定 `0/2/3`），与 `contract`
生命周期码**物理分离**，并在文中写明「`contract.exit` 不参与 health 判定」；或改用 dia 尚未占用的码段（如 `0/20/21`）。

### B2. 默认 60s 超时 + 1800s 间隔 ⇒ 健康成天是「过期 ok」

`healthcheck.interval` 默认 1800s，`timeout` 默认 60s。真实故障在两次检查之间有 29/30 的概率**仍显示上一次的 ok**，
这正是本文 §1 要解决的「三天没干活没人发现」——只是从三天缩短到 30 分钟，且 status 上没有任何「stale」标记。

**建议**：
- status 的 health 列显式带**新鲜度条款**：超过 `interval * 1.5`（或距上次结果过久）→ 显示 `stale`，
  不再显示上一次的 ok（或显示 `ok (stale 47m)`）。
- 明确「dia 只托管调度，检查由 job 后端周期性拉起；错过窗口本身不算 fail」。

### B3. 超时消抖 vs 超时记 degraded：自相矛盾；其余状态的消抖缺失

- 图中 `ok --> degraded: 连续 2 次 exit 2`（要连续 2 次），但 §4 只写「超时记 degraded」——**超时算 1 次还是 2 次？**没说。
- 只有 `ok → degraded` 需要连续 2 次；`degraded → fail`、`fail → ok`、`fail → unknown` 都是一步到位。
  **既然承认 degraded 可能是噪声，fail 为什么不需要消抖？** 单次 `exit 3`（例如一次 API 503）就会把状态打成 fail，
  下一轮又 ok → 状态图在原地反复横跳，而「历史落台账」会把每一次抖动都记进去。
- `degraded → unknown`、`ok → unknown` 在图中**不存在**；但按 B4，healthcheck 自身崩溃在任何状态都可能发生。

**建议**：把去抖写成**统一规则**（任意 `level` 连续 N 次才切），给出 `N` 默认值与配置位（如 `healthcheck.debounce: 2`）；
状态图补全 `ok → unknown`、`degraded → unknown`；`fail → ok` 也要求连续 2 次（避免 ping-pong）。

### B4. `unknown` 的实际可达路径几乎不存在，而且它与「崩溃」的定义打架

- 图里 `fail --> unknown: healthcheck 自身崩溃`，但 §4 又写「**自身崩溃 → unknown**」——**是所有状态都能进 unknown，
  还是只有 fail 能进？**图与文字互相矛盾。
- 更实际的问题：`unknown` 只在「进程出口可判」时才能区分「脚本崩了」与「脚本正常退出并报 fail」。实践中：
  SIGKILL / OOM / 超时被 job wrapper 杀掉 → 只有 `exit 137/143`，这和「服务自己退出 3」在 wrapper 层**不可区分**；
  而超时本身按 §4 又**记成 degraded 而非 unknown**，于是「unknown」只剩段错误、解释器缺失这类偶发一次性事件，
  不是稳定状态。
- 结论：`unknown` 的实际语义 ≈「还没有结果」+「上一次运行异常退出」两件事混在一个格子里。

**建议**：把两件事拆开：
- `unknown` = **从未检查 / 结果过期**（新鲜度问题，见 B2），由 dia 侧计算；
- 「检查自身崩溃」= 保持**上一次状态不变**，只记 `last_error` 事件并计数（连续崩溃 M 次 → 降级为 degraded 并明示「判据不可用」）。
  这样状态机可删掉 `fail --> unknown` 这条边，unknown 的入口只剩「无结果」。

### B5. `dia job status` 的 health 列由谁算？实时执行 healthcheck = status 被拖慢

§4「结果去向：并入 `dia job status`（一列 health）」+ §6「`dia job status` 每行增加 `health=...`」，
但**没有说 status 是读缓存还是实时执行 healthcheck**。§10 验收「不阻塞（healthcheck 慢不拖累 status）」暗示有实时路径；
§5 `health` 又写「立即跑一次（只读，不改状态）」——那么 status 是否复用同一实现？读哪个落点？
结合 §9 开放问题 2（`state.jsonl` vs `health.jsonl`）——**落点未定，status 列就无从实现**。

**建议**：
- 明确 status **只读缓存**（最近一次 health 结果 + 时间戳），零执行、零网络 IO；实时执行只走 `dia service health`。
- 落点先定：复用 `state.jsonl`，追加 `kind:"health"` 行（`packages/job/lib/json.mjs` + `state-last` 取最后一行，
  加 `--kind health` 过滤即可，无需新文件）；既满足「并入 job 台账」，也不引入新的根。
- 加一条不变量验收：**status 延迟不随服务数线性增长**（因为无执行）。

## C. P2 级问题（建议同步修，不阻塞冻结契约）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| C1 | `healthcheck.timeout` 在 cron 后端**没有执行机制**：`packages/job/bin/dia-job` 的 wrapper 只「执行任务 → 记 state」，不包 `timeout(1)`；而 `interval=2700s` 之类在 `cron_spec` 里会 `rc=3`（只支持 `*/N *` 与 `0 */H *`，H 整除 24） | 作者以为 dia 会守超时，实际不会 | 写明 wrapper 用 `timeout <sec>` 包裹 healthcheck 子进程（`packages/job` 需新增该层）；interval 不可表达 → 显式报错，与 `rc=3` 对齐 |
| C2 | healthcheck 子在**哪个 cwd / PATH / 数据根**下执行？`packages/job` 的 cron 行显式给 `PATH`，但 `entry.cmd` 是相对路径 | 同一 status 列可能因 cwd 不同「正常 / 崩溃」两种结果 | 写明：cwd = 服务安装目录（`entry` 所在仓根），PATH 继承 `DIA_JOB_CRON_PATH`；验收补一条「cron 环境下可跑」 |
| C3 | `dia service health <id>` 的**退出码**未定义（表里只说「输出三态」），与 `cli.md` §3 的关系未说 | 无法写单测断言 | 定为：stdout 出 JSON（结构同 §4），exit `0` ok / `30` degraded / `1` fail / `2` 用法错误；unknown 不单独返回 |
| C4 | `verify` 检查「lock hash」，但 `dia.json` **没有 files 哈希字段**（对比 `persona` 的 `dia.lock`） | 「lock hash」指什么不清楚，verify 一半是空操作 | 复用 `persona` lock 格式（files + sha256），或把 verify 缩到「entry 存在 + job registry 有该 id」 |
| C5 | `add` 校验「entry 在仓内」，但 `docs/entrypoints.md`/`kit-install.md` 定义了「稳定入口」`$DIA_JOB_ENTRY_DIR`（`~/.local/bin` 软链），`packages/job` 的 `ref-entry` 判定也认它 | 「仓内」与既有「稳定入口目录」两套规则 | `entry.cmd` 允许 ① 仓内相对路径（安装时由 dia 解析并链接到 `DIA_JOB_ENTRY_DIR`）；② 已安装的 ref-entry。仍禁止写 checkout 绝对路径 |
| C6 | 「缺省 `healthcheck` ⇒ 只报生命周期状态」与 §1 的 **adopted 服务**（无 `dia.json`）：status 显示什么？空列 / `n/a` / 不显示？ | 迁移期绝大多数服务是 adopted，这一格决定整列是否有用 | 明确 `health=n/a (adopted)` 与 `health=unknown (never)` 的区分 |
| C7 | §10 验收没覆盖 **B1 语义冲突** 与 **B2 新鲜度**；「不阻塞」不可判（多少算不阻塞？） | 缓冲期最容易漏 | 验收加：① contract.exit 与 health 同声明时以 health 专用码判定；② 超 `interval*1.5` 无结果 → `stale`；③ N 个服务下 status 基准可调（如 < 200ms） |

## D. 口味 / 范围（不阻塞，但建议明确口径）

- **D1**：补「明确做少量」——本提案只解决**脚本型**服务；agent 会话型服务（§9 Q1）建议写进 §0「不做什么」，
  并指向 `docs/acp-integration.md` 的 daemon 讨论（会话型健康由 ACP 侧负责）。
- **D2**：`dia.json` 的 `schema: 1` 是否与 `persona` 清单共用 `docs/persona-install.md` 的 schema？建议 §3 直接引用，避免两套校验器。
- **D3**：`lifecycle.target` 手写主机名与 `os.hostname()` 跨平台不一致（macOS 默认 `.local` 后缀）；写明比对口径（不区分大小写、去 `.local`）。
- **D4**：§9 Q4 选「只暴露状态」合理；§10 建议补「`dia service list --json` 含 `health` 字段」以验收可观测。

## E. 与既有实现的对照（便于改稿时引用）

| 文档主张 | 既有实现 | 差异 |
|---|---|---|
| `lifecycle.type` 映射 `--type` | `packages/job/bin/dia-job`：`install ... --type periodic\|bounded\|service` | 一致；Linux `service` = systemd `--user`，需 `loginctl enable-linger`，本文未提 |
| `job` 已能答「进程在」 | `status`：launchd `state` / systemd `active+MainPID` / cron **无进程状态** | periodic 服务在 Linux 上 health 是唯一判据，更需 B2 新鲜度 |
| 历史落台账 | `tasks/<name>.state.jsonl`，`json state-last` 取最后一行 | 可复用；加 `kind` 字段即可 |
| 退出码约定 | `packages/job` README「0/1/2/3/4/5」；`cli.md` 0/2/30/31/32/33 | **多套 2 的含义**；health 子进程码需与 job 码物理隔离，见 B1 |

## F. 改稿 check-list（要求作者逐条回复）

```
[ ] B1  health 专用退出码域，contract.exit 不参与 health 判定
[ ] B2  stale 新鲜度条款（超 interval*1.5 无结果 → stale，不显示旧 ok）
[ ] B3  去抖统一规则（N 可配），状态图补 ok/degraded → unknown，fail→ok 也消抖
[ ] B4  unknown = 无结果/过期；healthcheck 自身崩溃 = 保持上次状态 + last_error
[ ] B5  status 只读缓存；落点 = state.jsonl kind:health
[ ] C1–C7 见上表
[ ] 同步 llms-full.txt / llms.txt / docs/index.md 摘要（当前提交已带，改稿需再生成）
```

## G. 三态裁决

| 对象 | 裁决 |
|---|---|
| 名词分层与「job 唯一调度」 | **通过** |
| healthcheck 契约（§4 状态机） | **不通过**（B1–B5） |
| CLI 面 / 迁移 / 验收 | **有条件通过**（C1–C7） |
