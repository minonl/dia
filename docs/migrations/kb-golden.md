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
