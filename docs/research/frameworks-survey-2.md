# 主流 Agent 框架设计对照（2026-10）

> 日期 2026-10-28。对象 13 个：LangGraph、CrewAI、AutoGen/AG2、OpenAI Agents SDK、Google ADK、AWS Strands、Semantic Kernel/MAF、LlamaIndex、Mastra、PydanticAI、smolagents、Claude Agent SDK、Codex SDK。
> 用途：给"零重依赖、审计优先、进化过程"的个人框架做设计校验。

---

## A. 对照表（摘要）

| 框架 | 定位 | 模型抽象 | 中间件/钩子 | 状态/恢复 | HITL | 多 agent | 评测 | 许可 |
|---|---|---|---|---|---|---|---|---|
| **LangGraph** | 图运行时 | BaseChatModel + `with_fallbacks()` | before/after_model、wrap_model/tool_call | checkpointer+thread，**replay/fork**（副作用会重放） | `interrupt()`+resume | 子图/supervisor/handoff | 无内建 | MIT |
| **CrewAI** | 角色团队 | `LLM("provider/model")`，无 fallback | task/step callback、guardrail | `@persist` 方法级 | Flow 人工反馈 | sequential/hierarchical | 弱（`crewai test`） | MIT |
| **AutoGen/AG2** | 群聊 | ChatCompletionClient+model_info | hookable message | save/load_state | UserProxy（无 interrupt） | GroupChat/Swarm | AutoGenBench | MIT/Apache |
| **OpenAI Agents SDK** | 轻 loop | Model/ModelProvider，**无 fallback** | guardrails+RunHooks | Session+**RunState 可序列化** | `needs_approval`→interruptions | handoff/agents-as-tools | 平台 tracing | MIT |
| **Google ADK** | 企业 agent+图 | BaseLlm 子类 | **6 类 callback** + Plugins | 事件溯源 + `app:/user:/temp:` | workflow 节点 | 层级/graph/A2A | **`adk eval`+evalset** | Apache-2.0 |
| **AWS Strands** | model-first | Model ABC + **ModelRouter(Fallback/Classifier)** | Hook（invocation/model/tool）+Plugin | SessionManager（File/S3/Snapshot） | 无一级中断 | Swarm/Graph/Workflow | 无内建 | Apache-2.0 |
| **SK → MAF** | 企业 .NET/Py | IChatCompletionService | Filters | MAF checkpoint | MAF workflow | GroupChat/Handoff | 无 | MIT |
| **LlamaIndex** | 事件驱动+RAG | Settings.llm + metadata | step 边界 | WorkflowCheckpointer（at-least-once） | `InputRequired` 事件 | AgentWorkflow | RAG 评测 | MIT |
| **Mastra** | TS 全栈 | 路由串+能力表 | processors(input/output/error) | snapshot+thread，**suspend/resume** | **suspend()/resume()** | workflow+supervisor | **scorers+datasets** | Apache-2.0 |
| **PydanticAI** | 类型安全 | Model+profile，**FallbackModel** | capabilities（before/after model、tool hook） | **无内建 session** | deferred tool 审批 | agent 委派 | pydantic-evals+Logfire | MIT |
| **smolagents** | 极简 | Model 类 | step_callbacks | 仅内存 | 无 | ManagedAgent | 无 | Apache-2.0 |
| **Claude Agent SDK** | Claude Code 当库 | 仅 Claude | hooks（PreToolUse/PostToolUse/PreCompact/SubagentStop） | **resume/fork**+checkpoint | permissions 回调 | subagents（≤20 并行） | 无 | Py MIT/TS 商业 |
| **Codex SDK** | Codex CLI 当库 | 固定 Codex | 无 hook | **resume(threadId)**，无 fork | approval_policy | 无 | 无 | Apache-2.0 |

**三个结构性事实**：
1. AutoGen 与 SK 已进维护模式，微软的答案是 MAF（2026-04）。
2. 真正"能中断再恢复"的只有 LangGraph / OpenAI / Mastra / Claude / Codex（Pydantic 靠 deferred tool）。
3. 内建评测完整的只有 ADK 与 Mastra。

---

## B. 该借的五条

1. **事件溯源会话**（ADK delta / Strands session）：消息与工具调用 append；state 分作用域；视图可重建 → 审计免费、可 fsck。
2. **双闸口**（LangGraph wrap_model/tool_call + Codex 审批）：`gate-model` / `gate-tool` 两个可执行钩子，stdin JSON、stdout 决策；绕过即失败。
3. **可序列化中断**（OpenAI RunState / Mastra suspend）：落 `runs/<id>/{state,interrupt}.json`，`resume` 跨进程续跑，不阻塞 stdin。
4. **模型 profile 声明化**（PydanticAI/Mastra）：`models.yaml` 写 context/tools/vision/价格/`verified_at`；路由 = fallback 链 + 预算，决策落审计。
5. **判据当门禁**（ADK evalset / Mastra scorers）：`evals/*.case.json` = 输入 + 期望工具轨迹 + 断言命令；收尾自动跑，不退步才允许 tag。

---

## C. 不该借的五条

1. **图 DSL 当唯一编排**：个人任务九成线性，节点/边/Reducer 成本高于收益。
2. **重型 durable runtime**（Temporal/DBOS 级）：违背零重依赖；文件 journal + 幂等键够。
3. **角色群聊多 agent**：token 贵、路径不可预测、责任链糊。
4. **平台绑定 tracing**：默认上行，离线/隐私不可控；本地 jsonl + 可选 OTLP。
5. **"SDK 包 CLI"的伪库**（Claude/Codex SDK）：模型锁死、行为随 CLI 漂移。

---

## D. 三个空位（我们有机会）

1. **审计即数据模型**：没人把"为什么"（判据、拒绝理由、成本、模型版本）做成一等字段；
   我们让每条决策带 `judge` 指针 + 证据哈希，可离线校验、可 diff。
2. **进化可回滚**：现有最多给分数，缺"候选→对抗→回归→落地→tag→rollback"生命周期与配额。
3. **零依赖可移植**：全部要包树 runtime；个人 agent 应 `git clone && bash install.sh` 即跑，配置纯文本可 grep/diff。

---

## E. 对 dia 的结论

| 我们的设计 | 对照结果 |
|---|---|
| 审计/门禁/证据一等公民 | **空位 1，方向正确** |
| 进化生命周期（候选→评审→落地→回滚） | **空位 2，方向正确** |
| 零依赖 + 纯文本配置 | **空位 3，方向正确** |
| 团/档位 | 与"角色群聊"同风险，**继续 defer** |
| 事件溯源会话 | 已有 dsh session；补"视图可重建"判据 |
| 可序列化中断 | 我们只有 resume 卡片，**应补 interrupt 文件** |
| 模型 profile | 已有 ModelSpec，补 `verified_at/price_ver` |
| 评测门禁 | 已有 H 体系，补 `evals/*.case.json` 形态 |

**一句话**：13 个框架验证了"审计/证据/可移植"是空位，也验证了"团/群聊/重运行时"是坑。
