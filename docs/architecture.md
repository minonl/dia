# 架构：框架 / 场景入口 / kit

> 日期 2026-10-27。本文回答一个问题：**什么该留在 dabo-agent，什么该抽到独立框架。**
> 依据：yan-agent 实测数据 + `dabo-agent:docs/research/system-survey.md`（外部引用）。

---

## 0. 结论

三层，各管一件事：

```
framework（独立项目）  ← 通用能力，无业务数据
   ↑ 被订阅                    ↑ 被订阅
yan-agent（工作场景入口）   dabo-agent（个人场景入口）  ← 只放本域数据、人格、工具、策略
   ↓ 订阅                      ↓ 订阅
kits（知识 / 技能 / 工具内容）  ← 可被两个域共同订阅，默认无执行权
```

**判定口径**：
- 两个域都要用 → 进 framework；
- 只有一个域用 → 留在该域；
- 可以被不同域按需装 → 打成 package。

---

## 1. 现状测量（yan-agent，2026-10-27）

| 指标 | 值 | 说明 |
|---|---|---|
| 知识文件 | 103 个 / 910KB | rules 26 / workflows 16 / repos 1 / tools 等 |
| 全库 token 估算 | **≈245k** | 不可能全量注入 |
| 索引 `index.md` | 87 行 / 15.6KB / **≈4.2k tokens** | 可注入 |
| **索引覆盖** | **74/103（72%）** | **28% 的文件从索引走不到** |
| **`review_by`** | **0/103** | 复审机制设计了，**从未落地** |
| 内部链接 | 118 条，**断 9 条（7.6%）** | 链接会烂 |
| 近重复内容 | **0 组** | 不是"重复"问题 |
| 常驻 daemon | 16 个 launchd | 已有独立调度的事实标准 |

> 结论：你说的"人读 md 不行了"，实测根因是**索引覆盖不全 + 复审没执行 + 链接会烂**，
> **不是文件格式**。换数据库解决不了这三件事。

---

## 2. 职责矩阵（谁拥有什么）

| 能力 | framework | yan | dabo | package |
|---|---|---|---|---|
| 预设注入（opencode/dsh 渲染） | ✅ 实现 | 提供 preset 内容 | 提供 preset 内容 | — |
| 知识索引 / 检索 / 复审队列 | ✅ 实现 | 提供知识 | 提供知识 | ✅ 知识 kit |
| 定时任务 / 调度 | ✅ 实现（launchd 生成） | 声明任务 | 声明任务 | — |
| 安全：预算 / 审计 / 冻结 / 豁免 | ✅ 实现 | 声明策略 | 声明策略 | — |
| 会话采集与脱敏 | ✅ 实现 | 可选开 | 默认开 | — |
| kit 管理（add/lock/verify） | ✅ 实现 | 订阅清单 | 订阅清单 | ✅ 被订阅 |
| 人格 / 域规则 | ❌ | ✅ | ✅ | 可提供片段 |
| 业务工具 | ❌ | ✅ | ✅ | ✅ 工具 kit（无执行权） |
| 业务数据（公司/个人） | ❌ **永不** | ✅ | ✅ | ❌ |

硬约束：
1. framework **不存业务数据**，读路径由域传参。
2. 域**不实现通用能力**（不自己写检索/审计/调度）。
3. kit **默认无执行权**；装包只落盘，执行需显式批准（ClawHavoc 教训）。

### 2.1 宿主适配（entry adapter，H0 补）

H0 抽样发现三层缺一个承接处：**宿主客户端/插件/本机环境**。它归**入口层的 adapter 子层**，不是第四层内核：

```
framework ← adapter → domain/kit
（framework 永不反向依赖 adapter）
```

- **职责**：Electron/DSH 客户端插件、宿主配置页、编辑器/浏览器插件安装、宿主专属 UI 适配。
- **不放进 framework**：adapter 依赖宿主版本，生命周期与引擎不同；放内核会让框架重新变胖。
- **不放进 kit**：kit 默认无执行权；宿主插件需要显式授权与宿主 API。
- **版本**：adapter 随宿主版本走；framework/domain 只暴露稳定契约。
- **验收**：`docs/research/h0/report.md` 的 3 条宿主任务必须有明确 adapter 归属；50 样本复验时按此口径重跑。

---

## 3. 知识存储：md 还是 sqlite？

| 方案 | 优点 | 缺点 | 适配度 |
|---|---|---|---|
| **A. md + 索引（现状）** | git diff 可审、人可改、可移植、LLM 直读、零依赖 | 无排名/元数据查询；索引靠人维护（实测 72%）；复审靠自觉（实测 0/103） | 中 |
| **B. sqlite 作主存** | FTS5 排名、结构化查询、原子更新、多域 tag | **无 diff、无法 PR 审阅、合并冲突、需要工具才能读、迁移成本、LLM 不能直读**、备份变二进制 | 低 |
| **C. md 为唯一事实源 + 派生 sqlite/FTS5 索引** | 保住 A 的优点，补上检索/元数据/复审队列；索引可删可重建 | 需要构建步骤；存在"索引过期"风险（可用"删库重建结果一致"测试消除） | **高** |

**推荐 C**，规则写死：

1. **只有 md 可写**；`index.db` 是派生物，删掉必须能重建，且重建结果可复现（测试断言）。
2. 检索、复审队列、断链检查、索引覆盖统计，全部由工具生成，不靠人手维护。
3. SQLite 只放两类东西：**派生索引** + **会话/回合等状态数据**，不放"人类知识"。
4. 复审不再要求人写 `review_by`：用 `git log -1` 的修改时间 + 显式 `review_by` 覆盖，自动生成到期队列。

**行业佐证**：Hermes 用 SQLite 存消息、用 md 存记忆与技能；OpenClaw 用 SQLite 存会话、md 存记忆。
**没有一家把人类知识的主存放进数据库**。

---

## 4. 抽取顺序：先在 yan 上"绞杀"，dabo 做第二消费者

不做"先写完框架再迁移"（那是瀑布，且没有真实使用）。用 strangler：

1. **定义契约**（framework 对外接口）：`kb search/get/lint`、`task add/list/due`、`audit append/verify`、`freeze/thaw`、`persona render`、`kit add/verify`。
2. **新项目里实现最小版**，直接读 yan 的现有知识目录（只读），跑出与现状一致的索引/检索结果。
3. **yan 切换**：先把 `yan-kb` 的检索切到 framework，其余保持不变（可回退）。
4. **dabo 接入**：只写自己的 preset + 域知识 + 策略，通用能力全部来自 framework。
5. **出 kit**：把 yan 里可复用的知识/技能打成 kit，两个域按 lockfile 订阅。

判据：
- 切换前后同一查询结果集一致（抽样 20 条）；
- 索引重建两次结果哈希一致；
- yan 的一周真实使用无回归；
- dabo 能只靠"preset + 域数据"跑通同一套门禁。

---

## 4.1 执行后端模式（2026-10-28 补充）

dia 不拥有运行时；执行后端按场景选：

| 模式 | 后端 | 适用 |
|---|---|---|
| 共享 daemon | opencode 用户级 server | 交互式、长会话 |
| 私有 server | `opencode serve --standalone` | 需要隔离 |
| 嵌入式 | `@opencode/sdk`（内存 router） | 无端口、版本锁定 |
| one-shot | `dsh headless` | 批处理 / canary / 基准 |

判据：同一任务在任一后端跑出的审计/成本/结果必须可比较（同一 `task_id`）。

## 5. 第一个真实任务（解决"零使用"）

**采集本机 dsh / opencode 会话 → 脱敏 → 归一化为回合 → 生成知识候选**。

| 步 | 做法 | 判据 |
|---|---|---|
| 读 | dsh: `~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd`；opencode: `~/.local/share/opencode/opencode.db` | 能列出会话数与时间范围 |
| 脱敏 | 凭据/token/内网域名/工号 → 占位符；规则可测试 | 样例集 100% 命中；误伤 <5% |
| 归一 | 统一成 `episode{ts, domain, task, actions[], outcome}` | schema 校验 |
| 候选 | 只产"候选"，不自动写知识 | 候选必须人工确认 |

隐私边界：**dabo 域默认开采集；yan 域默认关**（工作会话不出本域）；跨域只共享方法，不共享数据。

---

## 6. 对现有 dabo 设计的影响

| 现 design 章节 | 处理 |
|---|---|
| §5 团 / §5.2 档位 | **移出**或删；先做"预设组合"，H4/H5 未过不动 |
| §6 四层记忆 | 压成 **knowledge（md）+ evidence（episodes/logs）**；预算逻辑进 framework |
| §7.1 gateway 形态 | 通用调度进 framework；dabo 只声明任务 |
| §10 安全（审计/冻结/豁免） | **进 framework**；dabo 只写策略值 |
| §15 拥抱变化（adapter/probe/migration） | **进 framework**；dabo 只选目标 |
| 人格 / 协议 / 域知识 / 业务工具 | **留在 dabo** |

---

## 7. 早期待定 → 2026-11-03 结论

1. **名字 / 位置**：叫 `dia`，仓库 `minonl/dia`（private），装到 `~/.local/share/dia` + `~/.local/bin/dia`。
2. **知识存储**：按 C 方案落地——md 主存 + 派生 sqlite/FTS5 索引（`dia kb index/search/query`），索引可删可重建。
3. **抽取顺序**：yan 先行、dabo 第二消费者，均已成 dia persona（`dia persona add`），工作域 / 个人域各一套知识根与数据根。
4. **kit 最小粒度**：**仍未定**。实际只用到 `add/list/verify/remove`，大部分内容由 persona 的
   `files/skills/dirs/config` 内联承担；`kit show/update/gc` 未实现。
