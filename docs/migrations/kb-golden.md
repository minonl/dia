# K0：kb 查询 golden（20 条）

> 2026-10-30。原始 query 只落在 yan 数据根，不提交到 dia 仓。

- 来源：`~/.yan-agent/observability/kb-calls-2026-10.jsonl`（3002 条）
- 抽样：`seed=30`，按 mode 分层（query/scene/rule/auto）
- 输出：`~/.yan-agent/observability/kb-golden-20.json`
- 本仓只记录方法、计数、哈希：
  - 数量：20
  - mode：query 9 / scene 6 / rule 3 / auto 2
  - `query_hash`：`7279ffeea514…`
- 用途：K1 `dia kb query` 的 parity 基准；**不是** CI 固定夹具（避免把工作域文本带进 public 仓）。

复现：

```sh
python3 experiments/kb-golden.py <kb-calls.jsonl> <out.json>
```


## K2.2 100 条基准（2026-10-30）

- 命令：`python3 experiments/kb-bench.py <kb-calls.jsonl> 100`
- 样本：100 条真实 query；原始数据只在 `~/.yan-agent/observability/kb-bench-100.json`
- 结果：
  - answerable 87
  - 规则召回 **121/132 = 91.67%**
  - answerable zero-hit **0**
  - top1 与旧实现一致 **75/87 = 86.21%**
  - dia top1 落在旧命中集合 **84/87 = 96.55%**
  - CLI p50/p95：旧 51.0/114.6ms，dia 57.1/82.2ms
- 结论：召回/排序达到 K2.2 质量门槛；绝对 p95 60ms 未达，但相对旧实现更快，延迟门槛需按环境改为相对基线，不能静默改口径。
