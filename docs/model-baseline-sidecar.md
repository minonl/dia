# 模型基准与 Sidecar 监控（A+B 一起）

> 日期 2026-10-28。
> A：**首次使用先跑基准**，用数据决定配置。
> B：**常驻 sidecar**，用同一套基准对比线上表现，及时发现模型降质/异常。
> 两者共用一套任务集与指纹，缺一不可。

---

## 1. 为什么必须 A+B 一起

- 只有 A：配置有据，但模型静默升级/降质无人发现。
- 只有 B：有监控，但没有基线可比，阈值只能拍脑袋。
- 合起来：**基准 → 配置 → 监控 → 异常 → 重跑基准 → 决策**，形成闭环。

---

## 2. A：首次使用基准

### 2.1 任务来源（公共 + 私有）

| 来源 | 用途 | 说明 |
|---|---|---|
| **公共基准 mini 子集** | 首次 baseline | BFCL 50 / τ² 10 / TB2 5；各用自己的 runner，dia 只**导入结果 JSON** |
| **私有任务（PR + episode 结合）** | baseline + 长期 canary | PR：代码/终端；episode：问答/结构化/工具；自包含、判据脚本化、脱敏、季度轮换 30% |
| **日期切片题**（LiveCodeBench 新月题） | 事故 canary 补充 | 训练集物理上不含 |

**污染规则**：SWE-bench / Aider / BFCL / tau / GAIA 已高度污染 → **只做首次画像，不做长期健康度**；健康度只看私有 canary。
详见 `docs/research/benchmarks-survey.md`。

### 2.1.1 基准任务集

每个任务类留 3–5 个 canary（合计 8–12 个），要求：

| 要求 | 原因 |
|---|---|
| 有确定性判据（可脚本校验） | 不靠人打分 |
| 输出短（≤500 token） | 控制成本 |
| 覆盖四类：长上下文 / 工具密集 / 低成本 / 高可靠 | 与路由类对应 |
| 不含敏感数据 | 不进第三方训练/日志 |
| 可轮换（held-out 留 20%） | 防过拟合与缓存 |

### 2.2 运行协议

对每个模型、每个任务：**跑 3 次**（取中位数），记录：

```yaml
task: { id, class, hash, judge }
runs: 3
metrics:
  success: bool
  steps: int
  tool_calls: int
  tool_arg_errors: int
  schema_errors: int
  parse_repairs: int
  tokens_in/out/cache: int
  latency_ms: int
  cost_usd: float
```

### 2.3 由基准推导配置

| 配置 | 推导规则 |
|---|---|
| `context_budget` | `min(声明窗口, 实测安全窗口) × 0.8 − maxOutput` |
| `max_steps` | 该类任务的 p90 步数 × 1.2 |
| `retry_policy` | 按失败类型分布：限流多→退避；解析多→修复循环 |
| `route_class` | 按实测（成功率/成本/延迟）落到四类之一 |
| `vote_eligible` | 成功率 ≥ 阈值且稳定（用于验收双票） |

**指纹与判据（修正）**：

```
fingerprint = sha256(suite_id|n|judge_id|judge_ver|temperature|seed|spec_id)
判据：同 fingerprint 重跑，逐题 pass 集合 Jaccard ≥ 0.95；flaky 题单列
```

产物：`~/.local/share/dia/baselines/<provider>/<model>@<date>.json`（含 spec_id、fingerprint、任务 hash、指标、配置、判据版本）。

---

## 3. B：Sidecar 监控

### 3.1 形态（已定：事故优先，定时默认关）

- **默认不常驻**：定时任务只提供**模板**（launchd plist / `sidecar --once`），**默认不启用**。
- **事故触发**：`dia model incident --model X` 立刻跑一轮 canary（3–5 个），对比基线，写 drift。
- 确认降级后 → 进**观察名单**，再为该模型启用定时监控（模板 + 节拍）。
- 独立进程，不共享主会话/上下文/凭据；只写监控数据，不改业务状态。

### 3.1.1 观察名单（watchlist）

状态机：

```
active ──drift──> watch ──确认降级──> degraded ──恢复──> active
                    │                    │
                    └── 启用定时监控 ────┘
```

- `watch`：已进观察名单，定时监控可开启；路由**仍可用**但标注风险。
- `degraded`：确认降质；路由建议 fallback，**切换需人批**。
- `retired`：不再使用，保留历史。

状态变更只追加到 `model_state.jsonl`（`{ts, model, from, to, reason, evidence}`）。

### 3.2 漂移判定（三个统计量，TS 自实现，零依赖）

设基线窗口 `n0, p0, μ0, σ0`（冻结），当日窗口 `n1, x1`：

| # | 用途 | 公式 | 判异 |
|---|---|---|---|
| 1 | 成功率漂移 | 双比例 z：`z=(p̂1−p0)/√(p̄(1−p̄)(1/n0+1/n1))` | `|z| > 2.58`（99%） |
| 2 | 趋势（EWMA） | `z_t=λx_t+(1−λ)z_{t−1}`，`λ=0.2` | `|z_t−μ0| > 3σ0√(λ/(2−λ))` |
| 3 | 降级起点（单侧 CUSUM） | `S⁺_t=max(0,S⁺_{t−1}+(x_t−μ0−kσ0))`，`k=0.5` | `S⁺ > 4σ0`；报警时刻即"由绿转黄"那一格 |

- 类别型（token 分桶/错误类型）补 PSI：`Σ(pᵢ−qᵢ)ln(pᵢ/qᵢ)`，`>0.2` 显著。
- 样本不足（`n1<10` 或基线 `n0<30`）→ 写"无法判定"，不下结论。
- 阈值进代码常量（单一事实源），文档不得另写一套。

**为什么不引入库**：Evidently/NannyML 需要 DataFrame + reference 窗口（≥1000 行），Alibi 是 BSL-1.1（非 OSI），whylogs 已停更；三个公式在 TS 里各 10 行，没有引入理由。

### 3.3 异常处置

```
事故/怀疑 → dia model incident（立刻跑一轮）→ 对比基线
        → 进 watch（观察名单）→ 启用定时监控 → 确认降级 → degraded
        → 路由建议 fallback（不静默）→ 人决定：恢复 / 降级 / 替换
```

- **不自动切模型**：只标记 + 路由建议，切换需人批（与"用户显式选模型 = strict"一致）。
- 事故模式保留现场：baseline 复跑结果 + 当轮 canary 明细 + 时间点。

---

## 4. 可视化（uptime 时间轴 + 日级热力图）

### 4.1 uptime 时间轴（按模型）

**定义**：`uptime = 当日 canary 通过率`；颜色三态：`≥0.99 绿 / ≥0.95 黄 / 其余红`。
CUSUM 报警时刻 = 降级的起点，直接标在时间轴上。

```
Kimi-K2.7-Code   ██████████▓▓▓███  (▓ = watch, ▒ = degraded)
GLM-5.3          ████████████████
DeepSeek-V4-Pro  ███████████▒▒███
```

### 4.2 日级热力图（contribution 风格）

每格一天，深浅 = 当日 drift 事件数 / 偏差幅度；点开（或 `--json`）看当日指标。

### 4.3 输出形态（零依赖）

- `dia model status --chart`：终端文本图；
- `dia model status --json`：输出 **Vega-Lite spec**（`rect` 分面 = 热力图，`line+band` = uptime 时间轴），可嵌 HTML；
- `dia model status --svg`：本地渲染静态 SVG（无需浏览器）；
- 将来要仪表盘再加 `Grafana + Infinity`（读 `/metrics.json`），不是现在的必需。

数据来源：`model_state.jsonl` + `drift_events.jsonl` + `baselines/*.json`。

**不引入**：Alibi（许可）、whylogs（停更）、Phoenix（ELv2）、Braintrust（闭源）、Metabase/Superset/Cachet（ETL 重）。

## 4. 数据结构

```yaml
baseline:
  model: provider/name
  version: <provider 声明或探测>
  created_at: ISO
  judge_version: v1
  config: { context_budget, max_steps, retry_policy, route_class, vote_eligible }
  tasks: [{ id, class, hash, metrics, runs }]
  fingerprint: { success_rate, steps_p50, tool_arg_error_rate, schema_error_rate, latency_p50, cache_hit }

drift_event:
  ts, model, metric, baseline, observed, delta, samples, verdict, action
```

---

## 5. 与现有组件的关系

| 组件 | 关系 |
|---|---|
| `deps.yaml` | 模型作为 `kind: model` 依赖登记（version/verified_at） |
| `runtime/calls.jsonl` | 线上成本/延迟/工具错误的来源 |
| `audit.jsonl` | 异常动作与人工裁决留痕 |
| `dabo-agent:docs/hypotheses.md`（外部引用） | H13/H14 的判据来自 baseline + sidecar |
| 路由 | 只用 baseline 得出的 `route_class`，不靠猜 |

---

## 6. 失败模式

| 风险 | 对策 |
|---|---|
| canary 太小 → 噪声误报 | EWMA + 连续 N 次；样本不足判"无法判定" |
| canary 太大 → 成本高 | 输出限 500 token；每天预算上限 |
| 缓存命中导致假快 | canary 轮换、变化 prompt 前缀 |
| provider 静默升级 | 记录 version/指纹变化；无法归因时标注"疑似" |
| canary 泄漏敏感数据 | 任务集固定且脱敏；禁止用真实会话做 canary |
| 过拟合 canary | 20% held-out；每季度从真实失败补题 |

---

## 7. 实现计划（A+B 同一批）

1. `dia model list`：ModelSpec + 能力探测（声明 + 首次探针，缓存 90 天）。
1.5 `dia model baseline --from <results.json>`：导入外部 benchmark runner 的结果（不重写 harness）。
2. `dia model baseline --model X --tasks <yaml>`：跑基准、写 baseline、输出推导配置。
3. `dia model sidecar --once`：跑 canary、对比基线、写 drift。
4. `dia model status`：列出每个模型的配置、指纹、最近 drift。
5. 接入路由与验收投票：只用有 baseline 且 `vote_eligible` 的模型。

**判据**：
1. 同 fingerprint 重跑，逐题 pass 集合 **Jaccard ≥0.95**；
2. 人为注入降质（缩短输出上限）能在 **1 轮**内被检出（critical = 工具参数合法率）；
3. 成本按 `task_id` 归集，重试计入同一任务。
