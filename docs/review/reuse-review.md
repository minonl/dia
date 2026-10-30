# 复用评审（REUSE REVIEW）— 2026-10-28

> 触发：用户指出"思考过程有很多拿来主义，没有验证就决定复用"。
> 本文是**评审材料**，不是结论文档；裁决需团队评审（人 + 独立复核）后写入。

---

## 1. 规矩（先立后评）

任何外部能力（库/插件/协议/别人的引擎）默认是**假设**。进入主路径前必须有 REUSE ADR：

```
主张：我们要复用它做什么
证据级：A 源码/官方文档 / B 官方博客 / C 第三方 / D 传闻
本地探测：命令 + 原始输出（没跑就写"未验证"）
失败模式：它坏了/变了/弃用了，我们怎么办
耦合代价：版本、许可证、维护者数量、退出成本
裁决：adopt / adapt / reject / defer（defer 必须写复查日期）
```

**闸门**：没有本地探测 → 只能 `defer`，不许进主路径。
**角色**：点子（选项）→ 爪子（probe）→ 炸毛（失败模式）→ 秤（复现）→ 大波（裁决）→ 人（批准）。

---

## 2. 本轮 probe 结果（可复现）

| # | 主张 | 命令 | 结果 | 证据级 |
|---|---|---|---|---|
| P1 | 抽 yan watchdog 引擎 | `cp -R watchdog /tmp && node --test test/*.test.js` | **失败**：硬编码 `~/Library/Application Support/yan-agent`、包名 `@example/dsh-watchdog`；`license` 字段缺失 | A |
| P2 | 生成 dsh bundle | 造 `~/.dsh/profiles/dia-probe/{package.json,cordis.patch.yml}` → `dsh --profile dia-probe --dump-config` | **通过**：patch 被正确组合（`dia-probe` 出现 5 次） | A |
| P3 | acpx 当 ACP 客户端 | `npm view acpx version license`；`npx -y acpx@0.21.1 --help` | **可用**：`0.21.1` / MIT；有 `--agent`、`--permission-policy`、`--non-interactive-permissions` | A |
| P4 | dsh ACP 端到端 | 查包 | 包存在（2 个），**未跑通 stdio 会话** | B |
| P5 | opencode 插件机制 | `opencode plugin list` | 可用；本地已有 `yan-oc-guard.ts`，其注释记录：**`permission.hook("evaluate")` 返回值不生效**，只能观测 | A |
| P6 | SKILL.md 跨家 | `ls ~/.agents/skills` | 目录存在（yan 的 skills），**未验证** opencode/dsh 实际发现 | C |
| P7 | 沙箱能力 | `sandbox-exec` 手工实验 | 网络阻断、写外拒绝、symlink 逃逸拒绝，均通过 | A |

---

## 3. 裁决矩阵

| # | 复用项 | 证据 | Probe | 裁决 | 理由 / 复查 |
|---|---|---|---|---|---|
| R1 | dsh 文件沙箱 | A | —（README 明确只文件） | **adapt** | 只在 dsh 内复用；独立 CLI 需自带 wrapper（已实测 seatbelt） |
| R2a | yan watchdog 引擎（法律） | A | P1：**license 字段缺失** | **defer** | 无许可证不得复用；需作者补 license；复查 2026-11-04 |
| R2b | yan watchdog 引擎（工程） | A | P1：硬编码路径/包名 | **defer** | 解耦约 3 行 patch + 测试可移植；判据：patch 后跑通全部测试 |
| R3 | acpx（ACP 客户端） | A | P3 通过 | **adopt-with-constraints** | 只能由 `dia run` 启动；版本写死 v0.21.1；禁止不可信 `--cwd/--agent`；pre-1.0 |
| R4 | dsh bundle 生成 | A | P2 通过（仅组合） | **adopt（待运行时复验）** | 需再跑一次真实 profile 启动；否则只是"声明被组合" |
| R5 | opencode 观测插件 | A | P5 部分 | **adopt-as-observer** | 只做审计/观测（1 行 audit 为判据）；拦截另立议题 |
| R6 | SKILL.md 跨家 | C | P6 未完成 | **defer** | 需在 opencode/dsh 各跑一次发现；复查 2026-11-04 |
| R7 | dsh ACP 端到端 | B | P4 未跑 | **defer** | 需要一次 stdio 会话（指纹/工具列表） |
| R8 | "无可执行插件 ABI" | C | — | **working assumption** | AgentPlugins/everyharness 存在但 <40★；季度复核 |

---

## 4. 评审要回答的问题（给炸毛/秤）

1. R1 的"adapt"是否掩盖了"独立 CLI 根本没有沙箱"这个事实？我们是否应该直接拒绝非 dsh 场景的高危执行？
2. R2 的 defer 是否等于"永远不做"？如果 watchdog 解耦成本 > 重写成本，是否应该只抄 `engine.js` 的判定函数（约 500 行）而不是整包？
3. R3 采用 acpx 是否违反"零依赖"？它是外部可执行而非库，是否可接受？版本 pin 策略是什么？
4. R5 的 opencode 观测插件对我们的价值是什么？如果只能观测不能拦，是否值得做？
5. R6 如果 SKILL.md 只在部分宿主被发现，我们的包格式是否要改成"每个宿主一份 skills"？
6. 有没有被漏掉的复用项？（例如 `ticktick`/`cc-switch`/`rulesync`）

---

## 6. defer 生命周期（评审后新增）

每条 defer 必须写：`revive_by`（日期）+ 一条命令级判据 + 负责人；**30 天未复活自动转 rejected**。
当前：

| 项 | revive_by | 复活判据 | 负责人 |
|---|---|---|---|
| R2a | 2026-11-04 | `package.json` 出现 license 字段 | 我 |
| R2b | 2026-11-04 | patch 路径后 `node --test` 全绿 | 我 |
| R6 | 2026-11-04 | opencode/dsh 各发现一次 `.agents/skills` 里的 SKILL.md | 我 |
| R7 | 2026-11-04 | `acpx exec --agent <dsh>` 跑通一次非交互会话 | 我 |

## 5. 评审记录（2026-10-28，独立复核）

**误报一条**：复核称"文档不存在"——因为它在 dabo 仓库目录执行 `ls`。实际文件在 `dia` 仓库，已提交 `cbf83b5`。
→ 流程修正：**评审必须声明仓库路径 + commit hash，并在结论里贴 `git -C <repo> ls-files` 输出。**

**接受的批评与修订**：

| # | 批评 | 修订 |
|---|---|---|
| 1 | R2 把"无 license（法律阻断）"和"硬编码路径（工程成本）"混成一个 defer | 拆成 **R2a 法律**（无 license → 不可复用，除非作者补 license）与 **R2b 工程**（路径/包名解耦，约 3 行 patch） |
| 2 | 4 条 defer 没有负责人/到期/复活条件 = 僵尸状态 | 新增 **defer 生命周期**：`revive_by` + 命令级判据 + 负责人；30 天未复活自动 `rejected` |
| 3 | R3 的 acpx 会形成**审计黑洞**（子进程继承权限，绕过 gate），且无 lockfile | R3 改为 **adopt-with-constraints**：只能由 `dia run` 启动（否则不计审计）；版本写死；禁止把不可信输入拼进 `--cwd`/`--agent` |
| 4 | R4 只验证 `--dump-config`，没验证运行时加载 | 增加 probe：真实 `dsh --profile` 启动一次，确认 patch 生效（不只是组合） |
| 5 | R5 方向错：`permission.evaluate` 不生效只影响"拦截"，不影响"观测" | R5 改为 **adopt-as-observer**：只要能写出 1 行 audit 即可；拦截另立议题 |
| 6 | R1 把"一条路径有隔离"表述成"有隔离" | 新增 **覆盖率表述**：`sandbox: dsh ✓ / CLI ✗（无隔离）`；doctor 必须显式输出 `sandbox: none`，不许沉默 |
| 7 | "推翻率 >20% 健康"会 Goodhart | 改为**配对指标**：`有效推翻 / (有效推翻 + 误报)`；单看推翻率不采纳（详见 evolution-process §4） |
| 8 | 信任度/意图漂移没有公式与事件 | 指标必须绑定事件与公式，否则不进表 |

**最致命的 3 条（接受）**：
1. R3 的审计黑洞（外部执行体绕过 gate）；
2. R1 的沙箱表述失实；
3. defer 没有复活判据 = 假 pending。

- **可以进主路径**：R3（外部工具）、R4。
- **必须 defer**：R2、R5、R6、R7。
- **已有能力但要限定范围**：R1（仅 dsh 内）。
- **反面教材**：P5 的 `yan-oc-guard` 注释——"文档说能拦，实测返回值不生效"；这正是本地探测的价值。
