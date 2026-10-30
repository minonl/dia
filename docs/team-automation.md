# 全自动团队：人只在验收介入

> 日期 2026-10-28。目标：**计划→实现→验证→对抗→修复全自动循环；人只在验收阶段拍板。**
> 前提：每个角色是宿主里的独立 persona；编排由确定性脚本驱动；模型只做角色内判断。

---

## 1. 自动机

```
queued
  → planning       (planner：计划 + 验收判据 judge + 任务拆解)
  → building       (builder：worktree 内实现 + 测试)
  → verifying      (verifier：独立只读，三态结论)
  → redteaming     (redteam：反驳清单，每条可复现)
  → fixing         (builder：逐条回应/修复；≤N 轮)
       ↑__________________________|
  → awaiting_acceptance  (生成验收包，停下)
  → accepted / rejected
```

**人在哪**：只在 `awaiting_acceptance` 出现；其余阶段人可看但不需要操作。
**谁能停**：确定性门禁（预算/判据缺失/连续失败）可自动升级到 `escalated`，同样停在人面前。

---

## 2. 角色与权限（能力包络）

| 角色 | 工具 | 读/写 | 不许 |
|---|---|---|---|
| **planner** | read, grep | 只读 | 写代码、改判据 |
| **builder** | bash, git, edit（仅 worktree） | 写 | 自签验收、改 judge |
| **verifier** | bash（只跑判据） | 只读 | 改代码、与 builder 同上下文 |
| **redteam** | read, bash（只复现） | 只读 | 空泛吐槽、改判据 |
| **lead（脚本）** | 无模型 | 编排/记账 | 代替任何角色判断 |

**硬规则**：builder ≠ verifier；verifier 只认命令+输出；`无法判定 ≠ 通过`。

---

## 3. 确定性门禁（脚本判，不看模型）

| 门 | 判据 | 失败 |
|---|---|---|
| 有判据 | `judge` 非空且可执行 | 回 planning |
| 测试 | builder 的测试命令 exit 0 | 回 building |
| 验证 | `verify.json` 含 `conclusion` 三态 + 证据 + commit | 回 verifying |
| 对抗 | `redteam.json` 每条有触发/后果/复现/严重度 | 回 redteaming |
| 自签 | verifier ≠ builder（会话/身份不同） | **拒绝** |
| 预算 | 轮数 ≤3、token/时长/成本 ≤上限 | `escalated` |
| 验收 | 以上全过 + packet 完整 | 停在人面前 |

---

## 4. 验收包（人只看这个）

```
runs/<task-id>/
├── plan.md            # 目标、判据、拆解
├── diff.patch         # 变更
├── test.log           # 测试命令与输出
├── verify.json        # 三态结论 + 证据
├── redteam.json       # 反驳清单 + 处置
└── packet.md          # 一页摘要：改了什么、风险、没做什么、结论
```

人只做：`dia team accept <id>` / `reject <id> --reason ...`。

---

## 5. 失败与升级

| 情况 | 行为 |
|---|---|
| 验证不通过 | 回 building，带证据修复（≤3 轮） |
| 同一失败重复 2 次 | 停止，标 `escalated`，附两次证据 |
| 预算超限 | 停止，附成本/轮数 |
| 判据不可执行 | 回 planning，要求可执行判据 |
| 需要政策/权限变更 | 标 `needs-human`，进验收包 |

---

## 6. 编排实现（不重写运行时）

```
dia team run <task-id>
  ├─ TeamDriver：start(role) / prompt(session, text) / collect(session) / close
  ├─ 首个驱动：opencode ACP（session/new → mode=role → prompt → 读事件）
  ├─ 次驱动：dsh ACP（profile 每角色一个）
  └─ 所有角色产物落 runs/<task-id>/，脚本校验后才进入下一阶段
```

- 角色 = persona（`dabo-planner` / `dabo-builder` / `dabo-verifier` / `dabo-redteam`）；
- 每个角色独立会话，**不共享上下文**；只传文件产物（plan/diff/report）；
- 编排器不调用模型，只调度与校验。

---

## 7. 非目标

- 不自动合并、不自动发布、不自动外发。
- 不允许 verifier 与 builder 同会话。
- 不允许没有判据就进入 acceptance。
- 不把"模型说通过"当通过。

---

## 7.1 实现状态（2026-10-28）

| 件 | 状态 |
|---|---|
| task ledger（add/list/status/done，done 需 judge+evidence） | ✅ |
| runs 目录 + 验收包六件 | ✅ |
| 门禁（六件齐全、verify 三态、证据非空、findings 合法） | ✅ |
| accept / reject | ✅ |
| `team run --mock` 状态机 | ✅（用于验证门禁） |
| **ACP 驱动（opencode）** | ✅ 跑通成功/失败路径 |
| **ACP 驱动（dsh）** | ✅ 每角色独立 profile（`dabo-{role}`），跑通成功路径 |
| dsh 用量 | ✅ 从 session 日志增量采集（实测 4 次调用 / 34k tokens，含 redteam） |
| 输出归一化 | ✅ PASS/FAIL/verdict → 三态；redteam issues → findings |
| H9 角色契约 | ✅ planner/verifier/redteam prompt 写死 JSON 字段与示例 |
| H10 修复循环 | ✅ 非法 JSON → 带 offset 重试一次；dsh 重试带 repo/judge/diff 上下文；二次失败升级 |
| 证据闸门 | ✅ 空/占位证据（`(no evidence)`）不可过 gate；planner 解析失败写 packet 并 escalated |
| 角色 persona（planner/builder/verifier/redteam） | ✅ 已装到 `~/.config/opencode/agents/dabo-*.md` |
| verifier/redteam 只读 | ✅ agent `edit: deny` + **只读工作副本**（shell 写也打不到原仓库） |
| 快照脱敏/清理 | ✅ 排除 `.env*`/`.npmrc`/`.git/config`/密钥；结束自动删（`DIA_KEEP_SNAPSHOTS=1` 保留） |
| 失败修复循环（≤3 轮） | ✅ opencode/dsh 均实测：`judge exit 1` → 4 次尝试 → `escalated`，gate/accept 拒绝 |
| dsh 角色只读 | ✅ planner/verifier/redteam profile 设 `sandbox-policy: read-only`；实测 `touch` 被拒（exit=1，文件未创建） |
| 成本/用量记账 | ✅ tokens 落 `runtime/model-calls.jsonl` + 每任务 `usage.json`（金额待价目表） |

## 8. 最小落地顺序

1. **task ledger + runs 目录**（状态机与产物）；
2. **`dia team run` 骨架**（无模型也能跑状态机，先回放假产物）；
3. **接入一个驱动**（opencode ACP），让 planner/builder 能产出；
4. **接入 verifier/redteam**，打开自动循环；
5. **验收包 + accept/reject**。

**只读隔离验证（2026-10-28）**：verifier 在 `runs/<id>/verify-ws-0` 副本里跑判据并通过；原仓库只保留 builder 的改动。
`opencode debug agents` 可见 `edit: * deny` 追加在 agent 规则末尾。

**已跑通的样例（2026-10-28）**：
任务「创建 answer.txt=42」，判据 `grep -qx 42 answer.txt`；
planner 出计划 → builder 写文件 → verifier 亲自跑判据（通过，4 条证据）→ redteam 看 diff（0 findings）
→ `team gate` ok → `team accept`。
产物：`plan.md / builder-0.md / verify.json / test.log / diff.patch / redteam.json / packet.md`。

判据：用一个真实小任务跑完整圈，人在 acceptance 只做一次 accept/reject；全程无人工触发 verifier。
