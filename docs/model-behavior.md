# 模型行为调控（客户端侧）

> 日期 2026-10-28。
> **边界（用户定）**：只使用各平台提供的通用模型；**不做本地构建/微调**；**不依赖**多数模型不支持的推理与输入输出控制参数；
> 所有调控都在**客户端本地**完成。

---

## 0. 一句话

> 不改变模型，只改变**模型看到什么、能做什么、输出要被怎样验收**。

模型是黑盒；我们能控制的是它的**输入契约、工具契约、输出契约和过程契约**。

---

## 1. 模型抽象（ModelSpec）

```yaml
model:
  id: provider/name            # e.g. example/Kimi-K2.7-Code
  contextWindow: int           # 必填，缺省按最小安全值（如 32k）
  maxOutput: int               # 可选，缺省按窗口的 1/4
  tools: bool|unknown          # 是否支持工具调用
  json: bool|unknown           # 是否支持结构化输出
  vision: bool|unknown
  streaming: bool|unknown
  cache: bool|unknown          # 前缀缓存
  source: declared|probed|assumed
  verified_at: ISO
```

**规则**：
- `unknown` 一律按**保守值**处理（不支持/最小窗口），不许"应该支持"。
- 能力来源必须记录（declared/probed/assumed）；`assumed` 不得进主路径。
- 本机实测：dsh 只暴露 `contextWindow` / `maxTokens`；opencode CLI 不暴露能力矩阵 → 必须自建探测。

**探测策略（已定）**：声明 + **首次使用探针**（一个极小请求，验证 tools/json/vision），结果写入 `model_fingerprints.jsonl`，缓存 **90 天**；探针失败 → 按不支持处理，不阻断主流程但记录 `degraded_reason`。

**配套**：`docs/host-control-surface.md`（宿主边界）、`docs/model-baseline-sidecar.md`（基准与监控）。

---

## 1.1 五家对照（源码/官方文档，A 级）

| 维度 | opencode | dsh | OpenClaw | Hermes | Pi |
|---|---|---|---|---|---|
| 模型目录 | models.dev（232 家）+ 兼容矩阵 | adapter 声明 + 发现接口 | model manifest | `(provider,model)→api_mode/key` | catalog + 覆盖 |
| 能力字段 | tools/input/output/limit/cache 价 | contextWindow/defaultMaxTokens/inputModalities | contextTokens | 基础 | capabilities/context/cache |
| 上下文 | AGENTS.md 就近+instructions | maxBytes + omitted/truncated marker | 稳定前缀/易变后缀 | stable→context→volatile | base+context+skills |
| 工具 | 按启用条件注入指引 | `toolUpdate=addition-only`、失败带 code | **定义跨 turn 冻结** | registry 自注册 | codemode 3000 token 预算 |
| 输出 | JSON schema 输入修复 | `INVALID_TOOL_OUTPUT` | 未验证 | 强制角色交替 | outputSchema，坏值失败 |
| 重试 | 10 次，2/4/8→10s 封顶+jitter | per-provider normal 5 次 | auth 轮换/冷却→模型链 | 429/5xx 重试，401/403 立即 | 429/5xx，2/4/8s |
| 缓存 | cacheKey + cacheFormat | 工具增量声明 | cache boundary + retention | system_and_3 断点 | promptCache short/long |
| 按模型回归 | **未验证** | **未验证** | **未验证** | **未验证** | **未验证** |

来源：opencode `model-compatibility.ts` / `tool-input-repair.ts` / `model-retry.ts`；dsh 本机源码；OpenClaw `prompt-caching` / `model-failover`；Hermes `prompt-assembly` / `context-compression-and-caching`；Pi `models.md` / `CHANGELOG`。均为 2026-10 · A。

**结论**：五家在"能力表 + 分层前缀 + 工具契约 + 错误码重试"上收敛；差异在缓存语义。
**空档**：没有一家公开"按模型跑 golden 回归"——这是 dia 的增量（H13/H14 与指纹）。

---

## 2. 六类杠杆（全部与模型无关）

### L1 上下文装配

| 手段 | 做法 | 代价 |
|---|---|---|
| 指令层级 | 系统/人设 → 域规则 → 任务 → 工具说明 → 历史 | 层级混乱会被后文覆盖 |
| 预算分配 | 给 system/tools/history/knowledge/output 分别定额（token 压力比） | 需按模型窗口换算 |
| 稳定前缀 | 三段：**稳定（人设/规则）→ 上下文（项目/知识）→ 易变（任务/时间）**；时间戳只进末段 | 顺序错就命中率归零（Hermes/OpenClaw 实测） |
| 截断策略 | 索引 + 按需读；截断留痕 | 检索失败会漏信息 |

### L2 工具接口

- 工具名与描述是**提示词的一部分**：名字动词化、描述写"何时用/何时不用"、参数带例子。
- **定义跨 turn 冻结**：同一会话里工具列表只增不删、按名排序；增删/乱序会击穿前缀缓存（OpenClaw 做法）。
- 失败回给模型时带 **code + 摘要**，让模型能自纠（dsh 的 `isError` 文本）；重复同参调用要检测并提醒（dsh `repeat-tool-reminder`）。
- **参数级校验放在执行前**（不靠模型自觉）；错误信息回给模型时给"可修复提示"。
- 角色按最小工具集发放（包络），不是给全集。

### L3 输出契约

```
schema 定义 → 生成 → 解析 → 校验 → 失败则带错误重试（≤2 次）→ 仍失败则降级为自由文本 + 人工复核
```

- **输入修复**可做（字符串化对象、数字/布尔字符串、删多余键），但必须**回显原文**；坏值不允许被"猜到"（Pi #10897 的教训）。
- 输出被截断的 tool call 必须显式失败，不能"丢调用留结果"（Pi #11227）。

- **永不信任解析**：解析失败不是异常，是预期分支。
- 重试必须带**具体错误位置**，不是"请重试"。

### L4 过程控制

- 计划 → 执行 → 自检 → 停止条件；步数/时长/成本预算。
- 关键写操作前 checkpoint；失败可续跑（对齐 evolution 的 V 模型）。
- 高风险步骤强制独立复核（不与执行同源）。

### L5 重试与回退

失败分类（必须分开计数）：

| 类型 | 处理 |
|---|---|
| 网络/超时 | 指数退避 + jitter；同一请求重试（opencode 10 次、2/4/8→10s 封顶） |
| 限流 | 读 `Retry-After`（封顶 15min）；否则退避；可切模型 |
| 鉴权失败（401/403） | **不重试**，立即失败并报配置问题（Hermes 做法） |
| 空响应/截断 | 缩小上下文或提高 maxOutput；重试一次 |
| 解析失败 | 带错误位置修复重试（≤2） |
| 工具报错 | 把 stderr 摘要回给模型；不自动重放破坏性命令 |
| 模型不可用 | 走 fallback 链；**记录降级**，不静默 |

本机证据：dsh `llm-retry` 已有 `maxRetries` / `delayMs` / `providerRetryAfterMs` / jitter —— 可复用，不重写。

### L6 选择与路由（已定：四类）

- **用户显式选模型 = strict**：不许静默换模型（OpenClaw 做法）；自动路由只在未指定时生效。
- 会话级 **affinity**（session id）用于缓存路由（opencode）；换模型/换凭据 = 缓存归零，必须记录。

| 类 | 判据 | 默认 | 备选 |
|---|---|---|---|
| 长上下文 | 输入接近窗口 / 大量检索 | 大窗口模型 | 压缩后换小窗 |
| 工具密集 | 多步工具编排 | 工具调用稳的模型 | 单步化后降级 |
| 低成本 | 批量/低风险 | 便宜模型 | 失败升级 |
| 高可靠 | 验收/外发/不可逆 | 强模型 + 投票 | 人工接管 |

- **健康闸门（修正）**：`gate(tier, health)`，`health={ok_rate_5m,p95_latency_5m,cost_1h,cooldown_until}`；
  准入条件 `ok_rate_5m ≥ SLO` 且 `p95 ≤ L` 且 `cooldown_until < now`；回退目标写进审计行。
- 路由变更必须走实验（H11），不许拍脑袋。

### L7 验收投票（已定：全部验收）

- **每个验收环节**默认 **2 个独立模型投票**（不同 provider 优先），结论不一致 → 回人裁决。
- 成本护栏：月度投票预算上限；超限时**降级为单票 + 人工复核**，并写 `degraded_reason`，**不许静默单票**。
- 便宜模型可作第二票，但不得与第一票同源（同一 provider/同一版本不算独立）。
- 投票记录进 `runtime/calls.jsonl`（`vote_group` + `task_id`），可复算成本与一致率。
- **tie-break**：两票不一致 → **人裁**，不许第三票自动决定。
- **同源排除**：judge 不得与被评模型同源（同 provider/同版本），防 self-preference。

---

## 3. 明确不依赖的旋钮（非目标）

| 旋钮 | 为什么不用 |
|---|---|
| temperature / top_p / top_k | 不同 provider 语义不同，有的不支持 |
| frequency/presence penalty | 同上，且难复现 |
| reasoning_effort / thinking budget | 只有部分模型有；字段名与语义都在变 |
| seed / stop sequences | 支持度不一，不能作为正确性保证 |
| logit_bias / logprobs | 多数托管模型不暴露 |

若某个模型支持，只能作为**可选加速**，不能成为流程正确性的前提；使用必须记录在 ModelSpec。

---

## 4. 行为观测与漂移

**失败分类**（每类单独计数，作为模型指纹）：

```
empty / refusal / schema_violation / tool_misuse / wrong_tool / loop /
truncated / hallucinated_tool / language_drift / latency / rate_limited
```

- 每个模型维护**指纹**：失败分布 + 平均步数 + 解析成功率 + 工具参数错误率。
- 模型版本变化（或 provider 静默升级）→ 跑同一组 golden 任务，指纹偏移超过阈值即告警。
- 记录在 `deps.jsonl`（模型也属于依赖）+ `model_fingerprints.jsonl`。

---

## 5. 可移植性（跨模型）

1. **提示词按能力类写**（长上下文类/工具类/推理类），不按具体模型写。
2. **评测按模型跑**：同一 golden 集，每个模型一份结果；不许拿 A 的成绩推断 B。
3. 模型特有 hack 只放 adapter，不进核心。
4. 换模型 = 一次迁移实验（shadow），不是改配置。

---

## 5.1 机制归属（已定：只做策略层）

| 机制 | 归属 | dia 的增量 |
|---|---|---|
| 重试/退避 | dsh `llm-retry` 或宿主 | 失败分类 + 指纹 |
| 压缩 | dsh `compaction-basic` / opencode | 预算策略 + 截断留痕 |
| 模型选择 UI | dsh / opencode | 四类路由规则 |
| 投票 | **dia 新增** | 独立性与成本护栏 |
| 指纹/漂移 | **dia 新增** | golden 集 + 告警 |
| 成本记账 | **dia 新增** | tokens/金额/投票组 |

> 原则同 sandbox：**宿主有的不重写，dia 只加策略与观测。**

## 6. 成本与延迟（客户端可控）

- 前缀稳定（缓存命中）、压缩（threshold/retain）、批处理、按任务预算限流。
- 成本记账到 `runtime/calls.jsonl`：tokens in/out/cache + 金额（若有价目表）。
- 预算超限 → 降级（换小模型/减少检索）或暂停请示人；不许静默继续烧。

---

## 7. 实验（待验证）

| # | 假设 | 判据 | 成本 |
|---|---|---|---|
| H9 | 工具描述重写能降低参数错误 | 参数错误率 ↓≥20%（同任务集） | 低 |
| H10 | 带错误位置的修复循环能提升结构化成功率 | 解析成功率 ↑≥15%，重试 ≤2 | 低 |
| H11 | 任务路由能降成本不降质量 | 成本 ↓≥30%，盲评质量不降 | 中 |
| H12 | fallback 链能提升限流下的完成率 | 完成率 ↑，降级次数可查 | 中 |
| H13 | 全部验收双票能降低错误 | 错误率 ↓≥20%，成本 ↑≤2×；一致率可复算 | 中 |
| H14 | 投票预算护栏不降质量 | 超限降级后错误率不升（盲评） | 低 |

---

## 7.1 我们的增量（五家都没有的）

1. **按模型跑 golden 回归**：每模型一份结果，升级/静默变更时比对指纹。
2. **投票独立性校验**：第二票必须异源（provider/版本），否则不算独立（Hermes 的 MOA 是多模型混合，但不是验收投票）。
3. **成本护栏**：投票预算 + 降级留痕；现有五家都没有"投票成本"概念。

## 8. 失败模式（诚实边界）

1. **提示词脆弱**：模型升级后同一提示行为漂移 → 只能靠 golden 集发现。
2. **能力误判**：把 `unknown` 当支持 → 运行时失败；必须 fail-closed。
3. **缓存破坏**：动态内容放前缀，成本翻倍。
4. **重试放大**：对破坏性操作自动重试 = 事故；只允许幂等操作自动重放。
5. **投票成本**：多模型投票在高频任务上不可持续，只用于高 stakes。
6. **评测过拟合**：golden 集太小会奖励"背题"；每季度从真实失败补题。
