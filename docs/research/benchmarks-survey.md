# 开源评测与基准：可用清单（2026-10）

> 日期 2026-10-28。回答：哪些开源项目的**真实任务**能直接用；哪些只能做首次 baseline（已污染）；私有 canary 怎么建。
> 判据：E=精确匹配，U=单测/脚本，J=LLM 评审，H=人工；依赖：D=Docker，B=浏览器，V=VM/GPU，W=联网。

---

## A. 清单（★/更新为 2026-10-28）

| 项目 | ★ | 许可 | 任务/子集 | 判 | 依赖 | 单次成本 | 证 |
|---|---|---|---|---|---|---|---|
| lm-evaluation-harness | 14.3k | MIT | 数百 task | E | – | $0–1 | A |
| HELM | 3.0k | Apache-2.0 | 40+ scenario | E/J | V | $5–50 | A |
| OpenAI Evals | 19.7k | 混合 | ~200 | E/J | – | $1–20 | A |
| Inspect AI | 3.1k | MIT | 131 包/~200 eval | E/J/U | 可选 D | $1–30 | A |
| promptfoo | 26.5k | MIT | 自带断言 | 自定义 | – | <$1 | A |
| DeepEval | 19.1k | Apache-2.0 | 指标库 | J | – | $1–10 | A |
| **SWE-bench** | 6.1k | MIT | 2294 / Verified 500 / Lite 300 | U | D | $0.5–5/题 | A |
| **Terminal-Bench 2.0** | 432 | Apache-2.0 | 89 题（2.1=91） | U | D | $0.3–3/题 | A |
| Aider polyglot | 49.8k | Apache-2.0 | 225 / 6 语言 | U | – | $2–10/轮 | A |
| RepoBench v1.1 | 215 | CC-BY-4.0 | Py/Java 补全 | E | – | <$1 | A |
| LiveCodeBench | 970 | MIT | 400 + 按月滚动 | U | 沙箱 | <$1/题 | A |
| **BFCL v4** | 13.1k | Apache-2.0 | 20 类目，100–800/类 | E(AST/执行) | 部分 W | $0.01–0.1/例 | A |
| **τ²/τ³（tau-bench）** | 1.5k | MIT | airline 50 / retail 114 / telecom 2285 | U(DB 终态)+J | – | $1–5/题 | A |
| AgentBench | 3.8k | Apache-2.0 | 8 环境 | U/J | D+B | 高 | A |
| GAIA | HF gated | 见卡 | 466（val 165） | E | W | $0.2–2/题 | A |
| WebArena | 1.6k | Apache-2.0 | 812 | U+J | D+B | 高 | A |
| OSWorld | 3.2k | Apache-2.0 | 369（small 子集） | U+J | V+B | 很高 | A |
| AssistantBench | 72 | 见仓 | 214 | E/F1+J | W | $0.1–1/题 | A |
| MLE-bench | 1.8k | NOASSERTION | 75 | U(奖牌线) | V+GPU | 极高 | A |

---

## B. 首次 baseline：最合适的 3 个

| 用途 | 集 | 规模 | 成本 | 为什么 |
|---|---|---|---|---|
| 工具调用 sanity | **BFCL simple/multiple** | 各 100 | ~$2 | 10 分钟内跑完，错误可定位 |
| 步数/上下文 | **τ² retail+airline** | 取 30 | ~$15 | 多轮工具 + DB 终态比对，直接给出 max_steps/context 初值 |
| 真实交付 | **Terminal-Bench 2.0** | 取 10–20 | ~$10 | 唯一同时压出步数/上下文/错误恢复 |

---

## C. 事故 canary：最合适的 3 个

1. **LiveCodeBench 滚动窗口**：按发布日期取近 6 个月新题，训练集物理上不含；单测判分。
2. **Terminal-Bench 2.1 固定子集**：与 2.0 不重叠，版本间可比。
3. **私有 canary（自建）**：从自己仓库近 90 天 merged PR 挖题，**永不公开、不写进 prompt/日志**。

---

## D. 污染与过拟合（必须写在文档里）

| 状态 | 基准 |
|---|---|
| **已高度污染**（不建议做长期监控） | SWE-bench、Aider polyglot、BFCL、tau-bench、GAIA |
| **低污染** | LiveCodeBench（按日期切）、Terminal-Bench 2.x（新题）、自己的 PR |

规避：
1. 按时间切 held-out（只跑 cutoff 之后的题）；
2. 判据不放题面（隐藏测试）；
3. 每季度轮换 30%；
4. 同模型跑 3 次；方差 > 分差则结论无效。

---

## E. 组合方案（已定：BFCL + τ²，$50/月封顶）

| 阶段 | 内容 | 成本 |
|---|---|---|
| 冷启动一次 | BFCL 50 例 + τ² 10 题 + 私有 8 题 | **≈$15–17** |
| 月度 canary | 私有 10 题 + （可选）LiveCodeBench 新月题 5 | **≈$10–20/月** |
| 事故加跑 | `dia model incident` 立即跑私有 10 题 | ≈$2–5/次 |
| **月度总封顶** | 基准 + canary + 事故合计 | **$50**（超限降级为 3 题抽样） |

**私有题源（已定：PR + episode 结合）**：
- **PR 类**：近 90 天 merged PR → 问题描述 + 隐藏测试（代码/终端任务）；
- **episode 类**：从已有 257 条会话抽自包含任务（问答/结构化/工具调用）；
- 两类都脱敏、判据脚本化、冻结入库；季度轮换 30%。

**私有题池流水线**：
```
git log --since=90d --merges → 取「问题描述 + 隐藏测试」→ 脱敏 → 人工过一遍 → 冻结入库
每季度复审，半年淘汰 30%
```

这是唯一不随公开榜单饱和而失效的部分。

---

## F. 对我们实现的含义

1. **不重写 benchmark harness**：TB2/τ²/BFCL 各用自己的 runner；dia 只**导入结果 JSON** 进 `baselines/`。
2. **canary 只用私有**（公开题只做首次画像）；私有题从 episode/PR 生成，判据脚本化。
3. **成本护栏**：canary 单次预算上限；超限降级为 3 题抽样。
4. **可重复性**：记录模型版本、题集 hash、判据版本、运行时间；缺一项视为"无法判定"。
