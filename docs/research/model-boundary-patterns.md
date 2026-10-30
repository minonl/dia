# 模型边界控制与调优：模式与修正（2026-10）

> 日期 2026-10-28。范围：客户端侧（适配/中间件/路由/护栏/评测/监控），不做训练与 provider 私有参数。
> 结论先行：**不做学习型路由、不做在线 bandit、不自造 telemetry 命名**；引入"档位纯函数 + 健康闸门"、"spec_id + 指纹"、"Kayenta 式 canary 判据"。

---

## A. 模式表

| 模式 | 代表 | 解决什么 | 代价 | 级 |
|---|---|---|---|---|
| 别名 + 部署池 | LiteLLM Router（`order`/`weight`/`allowed_fails`/`cooldown_time`/`num_retries`） | 多 provider 统一；失败隔离到部署 | 别名膨胀、语义被抹平 | A |
| 声明式网关 | Portkey config（`single/loadbalance/fallback/conditional`） | 策略与代码解耦 | 配置即代码，需 schema | A |
| 客户端中间件 | Vercel AI SDK `wrapLanguageModel`；LangChain `@before_model/@after_model` | 请求/响应两侧插重试/日志/脱敏 | 流式改写要缓冲到块结束 | A |
| Provider 抽象 | OpenAI Agents SDK `ModelProvider` | 换 provider 不改业务 | 能力差异靠探测 | A |
| 学习型路由 | RouteLLM（`mf/sw_ranking/bert/causal_llm`） | 成本降 35–85% @ 同质量 | 需标定集；漂移后静默失效 | A |
| 商业 Pareto 路由 | NotDiamond `tradeoff` | 免训练起步 | 黑盒 | A/C |
| 统计式 canary | **Kayenta**（Mann-Whitney + pass/marginal 阈值 + 0–100 分） | 区分抖动与真退化 | 需基线时序与样本量 | A |
| 阈值式 canary | Flagger / Argo Rollouts（`threshold`/`failureLimit`/`consecutiveErrorLimit`） | 简单、回滚时间可算 | 长尾不敏感 | A |
| SLO 燃烧率 | Google SRE（14.4×/1h、6×/6h、1×/3d） | 少误报 | 低流量失效 | A |
| 输入/输出护栏 | NeMo Guardrails / Guardrails AI / Llama Guard | "不许"变可执行 | **额外模型调用**（示例约 2×延迟、3.7×token） | A |
| 遥测标准 | OTel `gen_ai.*`（仍 Development，已改名一次） | trace/指标/成本同键 | 上游会变 | A |
| 按模型回归 | promptfoo / DeepEval / Inspect AI | 同题多模型 | 判分器自身要评；成本线性 | A |
| 在线 bandit | 仅论文 | 在线学习 | 非稳态 + 反馈延迟 | C |

**空档**：drift 检测在评测工具里不是一等公民（promptfoo/DeepEval/Inspect 只有矩阵对比）。

---

## B. 我们缺的六项（已确认）

| # | 缺口 | 修正 |
|---|---|---|
| 1 | ModelSpec 只有名字 | 加 `spec_id = sha256(provider\|model_id\|snapshot\|tokenizer\|tool_protocol\|price_ver)` |
| 2 | baseline 指纹未定义 | `fingerprint = sha256(suite_id\|n\|judge_id\|judge_ver\|temperature\|seed\|spec_id)`；判据改为**逐题 pass 集合 Jaccard ≥0.95**，flaky 题单列 |
| 3 | 路由无健康度 | `gate(tier, health)`：`ok_rate_5m ≥ SLO`、`p95 ≤ L`、`cooldown_until < now`；回退目标写进审计 |
| 4 | sidecar 缺症状分类 | `symptom_class ∈ {truncated, tool_arg_bad, refusal, hallucination, timeout}` |
| 5 | 投票无 tie-break / 同源风险 | 不一致 → 人裁；judge 不得与被评模型同源（self-preference） |
| 6 | 预算无单位经济 | 每任务 p50/p95、每档 ceiling、**重试计入同一 `task_id`** |

---

## C. 三条最值得引入

### C1 档位纯函数 + 健康闸门（两级）

```
route(req) -> tier                         # 纯函数，可快照
gate(tier, health) -> deployment | REFUSE  # 第二参数
health(d) = { ok_rate_5m, p95_latency_5m, cost_1h, cooldown_until }
准入: ok_rate_5m >= SLO_d 且 p95 <= L_d 且 cooldown_until < now
```

回退链显式声明，**"回退到谁"必须写进审计行**（LiteLLM 的 `fallbacks` + `allowed_fails` 语义）。

### C2 ModelSpec + 指纹 baseline

- 同 `fingerprint` 重跑才算对比；改了 judge/温度/题集 = 新实验体。
- 判据：**Jaccard ≥0.95**，而不是"差 <5%"（后者无法钉住噪声源）。

### C3 Kayenta 式降质检测

```
per_metric: pass | high | low        # Mann-Whitney 或比率比较
final = Σ w_i·pass_i / Σ w_i         # 0–100
fail  = final < marginal OR 任一 critical = high
critical: 工具参数合法率（failureLimit = 1）
```

四个指标够：**参数合法率、任务完成率、p95 轮数、单任务成本**。
参数合法率是唯一 critical——它掉就是硬伤，不看总分。

---

## D. 三条不该引入

1. **学习型路由**（RouteLLM/NotDiamond 自训）：需上千偏好标注 + 稳定分布；我们一天几十任务，标定集比流量大。
2. **在线 bandit**：反馈延迟以天计、奖励稀疏非稳态；用离线 A/B + 冻结集。
3. **自造 telemetry 命名**：OTel `gen_ai.*` 仍在变（`gen_ai.system` 已改名）；只写 `gen_ai.*` + `dabo.task_id` 关联键。

---

## E. 对 dia 的落地清单

| 动作 | 落点 |
|---|---|
| ModelSpec 字段 + spec_id | `docs/model-baseline-sidecar.md` §2 |
| fingerprint + Jaccard 判据 | 同上 §2.2 |
| gate(tier, health) | `docs/model-behavior.md` L6 |
| symptom_class | sidecar 数据结构 |
| 投票 tie-break + 异源 | `docs/model-behavior.md` L7 |
| 成本按 task_id 归集 | `runtime/calls.jsonl` |
| OTel `gen_ai.*` 字段 | 遥测（后续） |

---

## F. 参考文献（节选）

LiteLLM Router、Portkey Config、Vercel AI SDK Middleware、LangChain Middleware、OpenAI Agents SDK Models、RouteLLM（LMSYS 博客 + arXiv:2406.18665）、Kayenta Judge、Flagger、Argo Rollouts Analysis、Google SRE Workbook（Alerting on SLOs）、NeMo Guardrails Rail Types、Guardrails AI `OnFailAction`、Llama Guard 4、OTel GenAI semconv、promptfoo CI、DeepEval、Inspect AI。均 2026-10 复核，A 级为主。
