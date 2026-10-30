# 价目表（tokens → 金额）

> 日期 2026-10-29。原则：**没有价格就不编造**；`unpriced` 明确记录，预算按 tokens 兜底。

---

## 1. 数据来源

- `deepseek/*`：从模型目录取得真实单价（2026-10-29）：
  - `deepseek/deepseek-flash`：$0.15 / $0.60 / cache $0.003 per Mtok
  - `deepseek/deepseek-v4-pro`：$0.66 / $1.98 / cache $0.022 per Mtok
- `example/*`：**按免费（0）计**（用户 2026-10-29 定）；单价在 `prices.json` 里是 `0/0`，不是 unpriced。

## 2. 配置

`~/.config/dia/prices.json`（可覆盖默认；`DIA_PRICES_FILE` 可改路径）：

```json
{
  "example/deepseek-v4.1-flash": { "input": 0.2, "output": 0.8 },
  "vendor/model": null
}
```

- 未列出的模型 = unpriced，不估算。
- 价格单位：USD / 百万 tokens。

## 3. 记录

`runtime/model-calls.jsonl` 每行含：`model / input_tokens / output_tokens / total_tokens / cost_usd / priced`。
dsh 的 tokens 从 `~/.dsh/sessions/.../session.v4.jsonl.zstd` 的 `assistant/message.data.usage` 增量读取。
每任务 `usage.json` 汇总 `cost_usd` 与 `unpriced_calls`。

## 4. 预算

- 已知价格：按 `cost_usd` 累计。
- 未知价格：按 tokens 设上限（例如每任务 ≤200k tokens），并在验收包标注 `unpriced`。
- 月度封顶 $50（既有约定），超限降级/升级。

## 5. 局限

- 缓存计价只按 `cacheReadTokens` 粗略计算；provider 的缓存写/读折扣可能不同。
- 价格会变；以 `prices.json` 的 `updated_at`（建议手动记录）为准。
