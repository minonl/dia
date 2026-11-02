# 实验结果（pilot）

> 2026-11-02。base `61e0bc1d5`；固定 worktree；隐藏 judge。结果目录在仓库外。

## single

| run | wall | turns | tool calls | input tok | output tok | judge |
|---|---:|---:|---:|---:|---:|---|
| 1 | 172.5s | 32 | 48 | 94,042 | 8,212 | ✅ |
| 2 | 208.2s | 39 | 61 | 112,387 | 8,218 | ✅ |
| 3 | 192.8s | 32 | 52 | 75,980 | 7,349 | ✅ |

中位数：**192.8s / 32 turns / 52 tool calls / 94k input / 8.2k output**。

结论：任务可解，single 基线稳定；隐藏 judge 在 base 上失败、修后通过。

## dia-team-cli（非 ACP）

ACP 因 provider auth 不可用，改用 `opencode run --agent dabo-*` 跑 planner/builder/verifier（脚本 `run-team-cli.sh`，不冒充 ACP TeamDriver）。

| 指标 | 值 |
|---|---:|
| Wall | 350.4s |
| Steps | 66 |
| Tool calls | 95 |
| Input tok | 151,229 |
| Output tok | 10,445 |
| Diff | 3 files |
| 外部隐藏 judge | ❌ 9 个断言失败 |

内部 verifier 的 judge 是常量 `true`，因此它报告“通过”；外部隐藏 judge 证明它没有修到 engine 层。这个结果显示 **team 的内部验证会被弱 judge 骗过**，不是 team 的成功结果。

## ACP team 阻塞

- `opencode acp`：`Authentication required: provider authentication required`，未进入 planner。
- `dsh`：默认落到 `deepseek-official`，无 `DEEPSEEK_API_KEY`；`example` 模型设置未生效。
- 因此 **ACP team 没有可比结果**。

## superagent

未跑。完整链路需要 DSH profile + GitHub Source + issue 触发；Tier A worker 只能代表其 worker prompt，不代表完整产品链路。

## 下一步

1. 修 team 的模型/auth 路由（`opencode acp` 或 dsh profile），再跑 3 次；
2. 或先跑 superagent Tier A worker，与 single 对比代码/轮次；
3. Tier B 另建测试 GitHub issue，不与本地 one-shot 混比。
