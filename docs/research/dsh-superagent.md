# dsh-superagent-prototype 评审

> 2026-11-02。仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>
> 研究原型，MIT；约 8.9k stars；DSH bundle（`@deepseek-ai/dsh-*` alpha 依赖）。
> 结论：**产品哲学很像，架构不是同一个东西**；借概念与约束，不直接依赖/复制。

---

## 1. 它是什么

一个面向**单个 GitHub 仓库**的主动式 coding agent：

```text
Source（GitHub / Feishu）
  → Trigger（不可变事件）
  → Thread（按时间聚合）
  → Eval（Gate + Assessment）
  → Decision（accept / stop / ignore / unavailable）
  → Ticket（授权后的工作单元）
  → Assignment（绑定到一个 Executor Session）
  → Executor（独立目录 / DSH Session）
  → Channel（回复 PR/Issue/Feishu）
```

核心原则：**用最少的人类注意力换取最大价值**。只在被请求或已有书面规则允许时行动；只在人必须行动或结果可用时说话。

它带一个 Web panel，展示“需要人处理的事项”、系统健康和历史；支持 GitHub/Feishu 两个 Source，每个 Ticket 一个 worker Session/目录，有并发槽位、持久化 outbox、恢复与幂等。

---

## 2. 和 dia 的对照

| 维度 | dsh-superagent | dia 当前 |
|---|---|---|
| 定位 | 单仓 proactive agent 产品原型 | 通用框架 + 多角色团队 |
| 入口 | DSH bundle + panel | CLI/ACP + opencode/dsh |
| 领域模型 | Source/Trigger/Thread/Eval/Ticket/Assignment/Mandate | task/team/run/verify/gate（较扁平） |
| 授权 | Policy version + Mandate + gate + revalidate | accept/gate + 人工确认；无版本化 Mandate |
| 执行 | 一个 Ticket 一个 worker Session/目录 | 4 角色 team + ACP/dsh 多会话 |
| 验证 | worker 自验 + PR review；没有独立 verifier 角色 | builder/verifier/redteam 分离 |
| 知识 | 无通用 KB；prompt/skills | kb/ingest/audit/freeze 是核心 |
| 人类介入 | 结构化 Attention，panel 优先展示 | team `accept` + gate；无 attention panel |
| 持久化/恢复 | SQLite store + durable effects/outbox + slots | ledger/runs 文件；恢复能力较弱 |
| Prompt 版本 | 不可变版本 + override/base/升级提示 | persona/patch + next-session |
| 可移植性 | 强绑 DSH alpha | 目标跨 opencode/dsh，但仍有耦合 |
| 成熟度 | research prototype，明确不 production-ready | 早期框架，测试/门禁在补 |

---

## 3. 值得吸收的

1. **Attention 是一等公民**
   - “需要人”的结构化状态（answer/review/blocked/failed）比 `accept` 一个终态更细；
   - panel 先列“需要人”的事项，健康状态不占空间；
   - dia 可以把它落成 task/team 的 `attention` 投影，而不是加聊天消息。

2. **显式领域状态机**
   - Ticket 的 stage 由事实（report/input/assignment）推导，不靠自由文本；
   - 这比我们 `run` 里的临时状态更可测，能减少“看起来完成”。

3. **Policy version + Mandate**
   - 每个接受记录依据的 policy 版本、scope、strength；
   - policy 变化只通知受影响的 Ticket，不撤销已发 Mandate；
   - dia 的 gate/accept 可以参考，但不要一开始做全套。

4. **Durable effects / outbox / idempotence**
   - 外部动作先落库，再执行；失败退避；重启恢复；
   - worker slot / 并发上限 / 人类消息优先；
   - 这是 team 自动化从“能跑”到“可运营”的关键。

5. **Prompt 版本化**
   - immutable versions、override/base、默认更新提示；
   - 和 dia 的 persona patch 可以对齐。

---

## 4. 不该直接照搬的

- **不要替换 dia 为 DSH bundle**：它强绑 DSH alpha，和我们的 opencode/ACP/跨域目标冲突。
- **不要退化成单仓单 worker**：dia 的 builder/verifier/redteam 分离是刻意设计。
- **不要复制它的实现代码**：research prototype，工程一致性自述不保证；借概念即可。
- **不要先做 panel**：我们的宿主适配层（H0 的 adapter 缺口）还没定，先做 attention 状态和 CLI/API 更稳。
- **不要一次上全量 Ticket/Mandate 状态机**：先映射到现有 task/run，避免大爆炸重构。

---

## 5. 对 dia 路线的影响

优先级建议：

1. **attention 投影**：task/team 输出“等人工”的结构化状态（answer/review/blocked/failed），先 CLI，不先 UI。
2. **durable team run**：把 `team.ts` 的外部动作（ACP prompt、快照、gate）落成可恢复的 effect/outbox；先做最小重试与恢复。
3. **Mandate-lite**：accept 记录 policy/版本/scope/证据，policy 变化可追踪，不急着做完整 revalidation。
4. **panel 等宿主适配层**：H0 的 adapter 子层落地后再做 Web/宿主 panel。
5. **kb/job 继续按现有模块推进**，不要因为参考项目改方向。

一句话：**借它的“注意力优先 + 显式状态 + durable effects”，不借它的 DSH 绑定和单仓单 worker 形态。**
