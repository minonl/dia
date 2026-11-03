# 目标提案（team next）

> 日期 2026-10-29。定位：**团队可以提候选，不能定目标。**
> **状态（2026-11-03）**：v0 **已实现** —— `dia team next`（纯规则打分，不调模型）。
> 人只在两处介入：选目标（本命令的产出）与验收（team accept）。

---

## 1. 能力

`dia team next` 扫描已有信号，输出 **≤3 个候选目标**：

- 每个候选带：`why / evidence[] / 预计成本 / 风险 / 来源信号`
- **不创建任务、不改状态**；人选完后用 `dia task add` 立项。
- 纯规则打分（v0），不调用模型；模型只能后续用于措辞/归因，不参与决定。

---

## 2. 信号源（v0）

| 信号 | 来源 | 触发 |
|---|---|---|
| 升级任务 | `tasks/ledger.jsonl` 状态 `escalated` | 每个 escalated 任务一条候选 |
| 验证失败 | `runs/<id>/verify.json` conclusion ≠ 通过 | 反复失败优先 |
| 对抗高危 | `runs/<id>/redteam.json` findings.severity=high | 每条高危一条候选 |
| 依赖未验证 | `docs/deps.yaml` 的 `result: unknown` / `support: unknown` | 复核依赖 |
| 待验证假设 | `docs/hypotheses.md` 表格中的 `待验证`（按 `H1 / H2–H5` 展开为单条，并映射标题） | 低成本实验优先 |

**不采集**：会话原文、凭据、用户消息内容；只用 id/计数/结论。

---

## 3. 打分（v0）

```
score = severity_weight × 2
      + min(evidence_count, 3)
      - cost_penalty（low 0 / medium 1 / high 2）
```

- severity：high=3 / medium=2 / low=1；
- 同分按“最近出现”排序；
- 只输出前 N（默认 3）。

---

## 4. 数据契约（为后续能力准备）

每条候选：

```json
{
  "id": "p-...",
  "title": "...",
  "why": "...",
  "evidence": ["..."],
  "source": "task|verify|redteam|deps|hypothesis",
  "severity": "high|medium|low",
  "cost": "low|medium|high",
  "score": 7
}
```

后续要补的采集（v1）：
- escalated 的**归因分类**（判据缺失 / 环境 / 预算 / 模型能力）；
- 失败率的滑动窗口（不是单次）；
- 成本 p50/p95；
- redteam findings 的处置状态（fixed/waived/open）。

---

## 5. 边界

- **不是**自动路线图：没有 backlog、没有优先级共识、没有资源日历；
- **不替代人**：目标涉及价值与取舍，agent 无法承担；
- **数据不足时**：宁可少提，不编造；候选必须带证据。
