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

## dia-team

- `opencode acp`：`Authentication required: provider authentication required`，未进入 planner。
- `dsh`：默认落到 `deepseek-official`，无 `DEEPSEEK_API_KEY`；虽然 `callDsh` 设了 `example` 模型，但当前 profile/路由未生效。
- 因此 **team 没有可比结果**，不能写成“team 更慢/更差”。

## superagent

未跑。完整链路需要 DSH profile + GitHub Source + issue 触发；Tier A worker 只能代表其 worker prompt，不代表完整产品链路。

## 下一步

1. 修 team 的模型/auth 路由（`opencode acp` 或 dsh profile），再跑 3 次；
2. 或先跑 superagent Tier A worker，与 single 对比代码/轮次；
3. Tier B 另建测试 GitHub issue，不与本地 one-shot 混比。
