# dia msg M0：送达与可读（设计 v0.1）

> **一句话**：任意两个活会话互发消息，收件方无需用户手敲命令即可读到；正文持久、有 ack/reply/close。
> 日期：2026-11-05 ｜ 状态：**已确认，实现中（2026-11-05）** ｜ 上游需求：`docs/research/msg-collaboration-grill.md`（v0.2）
> 决策记录：2026-11-05 用户拍板「v1 只做 M0 送达与可读」；M1+ 以 M0 两周真实使用为前置。
> 本文只覆盖 M0；不写依赖图、TUI/Web、多机、daemon、全 worktree 锁。

---

## 0. 目标与非目标

| | 内容 |
|---|---|
| **目标** | 任意两个**活着的会话**能互相发送消息，收件方在**不需要用户手敲命令**的情况下看到未读；正文**不依赖临时文件**；有明确的 ack/reply/close。 |
| **非目标** | daemon、多机同步、角色别名、依赖图/TUI/Web、全 worktree 锁、自动合并/发布、替代宿主会话管理、跨宿主注入（codex/dsh 放到 M4）。 |
| **成功判据** | §7 的 6 条可执行验收全部通过；两周内执行过 `dia in` 的会话 ≥30%，否则按回滚线撤回。 |

**为什么只做 M0**：今天 4 条消息 12 小时无人读，收件会话还活着；缺口是“读的路径不存在”，不是“依赖图不存在”。

**边界（2026-11-05 用户校正）**：协议、存储、CLI、宿主适配器（opencode/dsh/codex）都是 **dia 框架能力**；
yan-agent 只保留「什么时候用」的 persona 行为规则，不承载插件代码，避免把框架能力做成 agent 内容。
**默认开启**：`msg` 是 dia 默认能力包（`kits/dia-msg`），所有 dia agent 默认带上；
新建 agent 不是聋哑的，用户可显式关闭（§5.0）。

---

## 1. 身份：v1 只认宿主 session id

### 1.1 解析顺序

```
--session <id>            # 显式（测试/脚本）
> DIA_SESSION_ID          # dia 自己的覆盖（可选）
> OPENCODE_SESSION_ID     # opencode 注入（本机实测存在此变量名；值不回显）
> E_NO_SESSION            # 明确报错，禁止猜
```

- **不按 cwd/标题猜会话**：今天 12 个会话共用 `/Users/min`，猜必错。
- **不打印 env 值**（R37）；只判断存在性，错误信息只说变量名。
- dsh/codex 暂无等价变量 → M0 标 `unaddressable`，不回退到 tmux 猜测。

### 1.2 会话记录

`~/.dia/collab/sessions/<session_id>.json`：

```json
{
  "schema": 1,
  "session_id": "ses_...",
  "host": "opencode",
  "display_name": "Dia 待完善之处",
  "cwd": "/Users/min",
  "project": "global",
  "host_pid": 12345,
  "started_at": "...",
  "last_seen": "...",
  "capabilities": ["msg:v2"],
  "address": "session:ses_..."
}
```

- `display_name` 来源：`--name` > opencode 插件上报的标题 > `opencode:<后 6 位>`；**只用于显示，不参与路由**。
- 注册时机：`dia whoami` / `dia in` 首次调用时 upsert；opencode 插件在 `session.created` 时也可写（见 §5）。
- 活跃判定：`last_seen` + 宿主进程存在（可选）；M0 不做心跳，只做“最近使用”。

### 1.3 地址

- M0 唯一地址：`session:<session_id>`；CLI 也接受裸 id。
- `role@project`、中文标题别名 **不做**；旧目录名只做迁移展示（§6）。

---

## 2. 存储

```
~/.dia/collab/
├── sessions/<session_id>.json       # 会话注册（可重建）
├── inbox/<session_id>/<msg_id>.json # 一消息一文件；状态也在这里
├── bodies/<msg_id>.md               # 超过 64KB 的正文；否则内联
├── threads/<thread_id>.json         # 可选索引：seq/参与者（可由 inbox 重建）
└── legacy/<slug>/<msg_id>.json      # 迁移的旧消息（只读）
```

- 目录 700、文件 600；不跟随符号链接。
- 写入：`tmp` + `rename`（沿用 `msg.ts` 的做法）。
- **正文持久化**：`--body` 内联；`--body-file` 发送时**复制**进 `body`（≤64KB）或 `bodies/<id>.md`；
  `show` 永远内联输出，不再打印“（见文件）路径”。
- 消息本身不可变；`state` 转换写回同一文件（M0 单机低并发，状态更新加 `mkdir` 锁 + 重试；不做 flock）。
- 容量：单条正文 ≤256KB，超出拒绝并提示用文件引用；M0 不做自动 GC，`close` 后可 `dia in --gc` 清理 30 天前终态。

---

## 3. 信封 v2

```json
{
  "schema": 2,
  "id": "m-...",
  "thread_id": "th-...",
  "seq": 1,
  "from": {
    "session_id": "ses_...",
    "display_name": "Dia 待完善之处",
    "host": "opencode",
    "cwd": "/Users/min"
  },
  "to": {
    "session_id": "ses_...",
    "display_name": "dws-hub ...",
    "host": "opencode"
  },
  "kind": "question|handoff|notify|reply",
  "subject": "...",
  "body": "...",              // 或 body_ref + body_bytes
  "refs": {"task": "t-...", "repo": "...", "commit": "...", "mr": "..."},
  "requires_reply": true,
  "deadline": "2026-11-05T18:00:00+08:00",
  "hops": 0,
  "reply_to": "m-...",
  "idempotency_key": "th-...#1",
  "created_at": "...",
  "state": "pending|delivered|acked|replied|needs_info|closed|escalated",
  "transport": "file|opencode-plugin|manual",
  "degraded_reason": null
}
```

- `from/to` 在 `dia in` / `show` / 注入文本里都完整展示（不再只有 from/to 两个字符串）。
- 幂等：`--idempotency-key` 可由调用方给；不给则 `thread_id + seq`，seq 在目标 inbox 的锁内计算。
- `queue` 语义不在 M0：`requires_reply` 只影响 `in` 的排序与超时提示。

---

## 4. 命令面（M0 最小）

```bash
dia whoami [--json]                 # 我是谁：session_id/display_name/host/cwd
dia in [--unread] [--json] [--limit N]
                                    # 收件箱；默认显示未终态；正文内联；from/to 全展示
dia out --to <session_id> [--kind question|handoff|notify]
        --subject S (--body B|--body-file F)
        [--reply-to <id>] [--requires-reply] [--deadline ISO]
dia ack <id>                        # 目标显式确认（禁止自动）
dia reply <id> --body B             # 回复并关闭原消息（hops+1）
dia close <id> --reason done|dropped|duplicate|escalated|no-follow-on
dia show <id> [--json]
dia msg send ...                    # 兼容别名 -> dia out
dia msg migrate [--dry-run]         # 旧 ~/.dia/msg -> ~/.dia/collab/legacy
```

- `dia in` 默认**不**自动 ack；只把 `pending` 标 `delivered`（记录 `delivered_at`），并打印“用 `dia ack` 确认”。
- `dia reply` 生成 reply 消息并写原消息 `reply_id`；`hops ≥3` 拒绝并提示转人工。
- `dia close` 是 M0 新增；`closed` 终于有生产者。
- 旧 `dia msg inbox/ack/reply/thread` 保留，读写同时兼容 v1/v2。

---

## 5. “不需要用户手敲命令”的实现

### 5.0 默认能力：`dia-msg` 是框架默认 kit

**一句话**：`msg` 不是某个 persona 自己加的规则，而是 dia 给每个 agent 默认带的能力包。

- **资产在 dia 仓**：`kits/dia-msg/`（`dia.json` + `skills/dia-msg/SKILL.md`），装配逻辑 `src/default-msg.ts`。skill 写清「什么时候用、怎么用、边界」。
- **默认安装**：`dia persona add` / `dia persona create` / `dia persona render` 默认 ensure 安装 `dia-msg` kit；
  skill 分发到 opencode / codex / dsh 的 skill 目录（按宿主存在与否），新 agent 不需要在 `dia.json` 里手写引用。
  - 安全阀：只有**默认数据根 `~/.dia`** 才自动装配，避免测试/CI 的临时 `DIA_ROOT` 把 skill 写进真实 HOME；
    自定义数据根用 `dia collab enable` 强制装配（或 `DIA_MSG_AUTO=1`）。
- **默认开关**：`capabilities.msg` 缺省 = `true`（旧 manifest 不加字段也视为开）。`dia collab disable`
  写 `~/.dia/collab/config.json`（全局或 `--persona <id>`）并移除 kit；`dia collab enable` 重新装配。
  `DIA_MSG=0` 可临时关闭自动行为（不删 skill）。
- **关闭语义**：`disable` 移除 kit（agent 不再看到 skill）并停自动注册/未读提示；`dia whoami / in / out`
  仍可手动使用。`status` 显示 `disabled` 及原因，不静默。
  - 按 persona 的 `capabilities.msg=false` 只阻止该 persona 的自动装配/更新；**硬关闭**用全局 `dia collab disable`。
- **覆盖**：yan-agent 等 persona 可以加更严格的规则（例如必须先 handoff 再收工），但不能把默认能力关掉；
  关掉必须走用户显式的 disable。

### 5.1 保证路径：框架默认 skill + persona 可选强化

- 默认 skill `dia-msg` 的 `description` 会出现在宿主的 skill 列表里；内容给出开工/收工协议：
  1. **开工第一条**：`dia whoami` + `dia in`（有未读先处理；不能处理就 `dia ack` 并说明）。
  2. **收工前**：`dia in --unread`；若有未读且未声明忽略，显式写出“还有 N 条未读”再结束。
  3. **需要对方行动**：用 `dia out` 建义务，而不是只发通知。
- yan-agent 的 AGENTS.md 可以额外写更严格的两条（例如必须 handoff），但**不是唯一来源**；
  其他 dia agent 也默认具备同样能力。
- 这不是“用户手敲”，是 agent 的默认动作；M0 的验收按此口径。

### 5.2 优化路径：opencode 适配器（dia 框架能力，0.5d spike，可选）

**边界先说清**：适配器属于 dia 框架，不属于 persona/agent 内容。

- 源码在 **dia 仓**（建议 `packages/host-opencode/` 或 `src/adapters/opencode.ts`），随 dia 版本发布；
- 由 dia 提供安装入口（如 `dia collab plugin install --host opencode`），落到 `~/.config/opencode/plugins/dia-collab.ts`；
- **yan-agent 只保留 AGENTS.md 行为规则**，不承载插件代码、不做宿主适配；
- 插件只调用 dia CLI/文件协议，**不直接写宿主 DB**；不能注入就降级到 §5.1 硬规则。

现有 `~/.config/opencode/plugins/`（复数）已有 v2 插件样例（`session-diary.ts` 使用 `export default { setup(ctx) }` + `ctx.event.subscribe()`）。
M0 spike 只验证两件事：

1. 插件能否拿到 `session.id`/标题并在 `session.created` 写 `~/.dia/collab/sessions/<id>.json`（低风险，预期可行）。
2. 插件能否在会话开始/空闲时把 `dia in --json` 的未读摘要注入会话（`prompt`/`session_inbox`/client API 三者之一）。
   - **不直接写宿主 DB**；不调用未公开 API 做写入。
   - 不能注入 → 插件只做注册，读仍靠 §5.1 硬规则（不阻塞 M0）。

---

## 6. 迁移旧数据

- 旧 `~/.dia/msg/<agent>/inbox/*.json`：逐条读取；`body_file` 存在则**复制内容**进新消息（不存在则保留原路径并标 `body_missing`）。
- 旧 `to` 是会话标题，**不猜 session id**；统一落到 `legacy/<slug>/`，`dia in --legacy` 只读展示，提示“这是旧地址，无法自动回复”。
- 旧目录名 → slug：保留原文，文件名用 hash 后缀防重名；不删旧数据（M0 只读迁移）。
- `dia msg agents` 打印 deprecation 提示，列出 legacy 目录。

---

## 7. 验收（可执行）

| # | 判据 | 命令/证据 |
|---|---|---|
| V1 | 两个活会话身份不同且可注册 | 两个会话各跑 `dia whoami --json`，`session_id` 不同；`~/.dia/collab/sessions/` 有 2 个文件 |
| V2 | 送达不依赖临时文件 | A `dia out --body-file /tmp/x.md`；删 `/tmp/x.md`；B `dia in` 仍看到完整正文 |
| V3 | from/to 完整可见 | B 的 `dia in` 输出含 `from.display_name/session_id`、`to.session_id`、主题、回复命令 |
| V4 | 闭环 | B `dia ack` → A `dia show` 看到 `acked`；B `dia reply` → A `dia in` 看到回复且原消息 `replied` |
| V5 | 无 daemon/tmux | `ps` 无新增常驻；`tmux ls` 不存在也能全流程 |
| V6 | close 生效 | `dia close --reason done` 后 `dia in --unread` 不再出现；30 天内 `--gc` 可清理 |
| V7 | 旧数据不丢 | `dia msg migrate --dry-run` 列出 4 条；执行后 `dia in --legacy` 可读，正文完整 |
| V8 | 使用率（两周） | 统计 `~/.dia/collab/sessions/*.json` 中 `last_seen` 且执行过 `in` 的会话 / 活跃会话 ≥30% |
| V9 | 默认能力包 | `dia persona create x --dir /tmp/x` → `dia persona add /tmp/x` 后 `dia kit list` 含 `dia-msg`；宿主 skill 目录有 `dia-msg` |
| V10 | 可关闭 | `dia collab disable` 后 `dia collab status` = disabled；`DIA_MSG=0 dia in` 仍可手动用 |

> V1–V7 必须在 CI/本机 e2e 可重复；V8 是人工统计，不达标触发回滚线。

---

## 8. 实现拆分（预计 3–4 天）

| # | 任务 | 产出 | 判据 |
|---|---|---|---|
| 1 | `src/collab.ts` | 身份解析、会话注册、v2 信封、inbox 读写、状态机、锁 | 单测覆盖 send/in/ack/reply/close/幂等 |
| 2 | `src/msg.ts` 适配 | v1 读取、v2 写入、legacy 映射 | 旧 4 条可读 |
| 3 | `packages/cli/src/index.ts` | `whoami/in/out/ack/reply/close/show/migrate` | help 与实际一致；`--json` 稳定 |
| 4 | 测试 | 两个 fake session id 的 e2e；并发 send/状态更新 | CI 全绿 |
| 5 | 迁移命令 | `dia msg migrate` | dry-run/幂等；不删旧数据 |
| 6 | **dia 默认 kit** | `kits/dia-msg/` + `src/default-msg.ts`：persona add/create/render 默认 ensure 安装；`capabilities.msg` 缺省 true；`dia collab enable|disable|status` | V9/V10；旧 persona 不加字段也默认开 |
| 7 | dia 宿主适配器 spike | **dia 仓** `packages/host-opencode/`（或 `src/adapters/opencode.ts`）+ `dia collab plugin install --host opencode`；注册 + 未读注入（可选） | 能注册；注入结论写回本文；不写宿主 DB |
| 8 | yan-agent 可选强化 | 仅在 AGENTS.md/knowledge 追加更严格规则，不承载代码 | 规则与默认 kit 不冲突 |
| 9 | 文档 | `docs/msg-collab-m0.md` 使用说明 | 新人按文档 10 分钟跑通双会话 |

**发布顺序**：1→2→3→4→5→6 在 dia MR 合并；7 独立 spike MR；8 在 yan-agent 直接 push main（R1.7，仅规则）；9 同 3。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| `OPENCODE_SESSION_ID` 在 dsh/codex 不存在 | 明确 `E_NO_SESSION`；dsh/codex 适配放 M4，不猜地址 |
| 同一 cwd 多会话 | 身份用 session id，不用 cwd/标题 |
| 会话 resume 后 id 变化 | M0 以宿主 id 为准；resume 产生新 id 就注册新会话（消息不自动迁移） |
| 插件注入不可用 | 回退 §5.1 硬规则；不阻塞 M0 |
| 旧标题映射错误 | 不猜；落 legacy 只读 |
| 邮箱增长 | close + 30 天 GC；M0 先手工 |
| 使用率低 | 两周 <30% ⇒ 回滚到手写 inbox + 硬规则，写回失败原因 |

---

## 10. 待确认（设计确认点）

1. `dia in` 默认把 `pending` 标 `delivered` 是否可接受？（不自动 ack）
2. `display_name` 是否用宿主标题？标题含中文/空格/重名时是否需要人工 `--name`？
3. 单条正文上限 256KB 是否够？（超过用 `body_ref` 文件引用）
4. 旧 4 条消息是否同意“只读 legacy、不猜 session id”？
5. M0 是否接受“插件注入失败 → 靠 AGENTS.md 硬规则”的降级？

> 确认后按 §8 拆 todo 开工；实现分支从 `origin/main` 起 worktree，提交信息 ≤15 字符，MR 走 `@bot mergeme`。
