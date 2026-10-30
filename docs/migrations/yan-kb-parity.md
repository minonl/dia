# yan-kb 兼容设计 v2（grill 后）

> 2026-10-30。触发：9 条 query golden 上，旧实现规则召回 10/12、top1 5/9；
> dia top1 5/9、1/9 零命中。现有方案只能证明“调用切换”，不能证明“能力兼容”。
> 本文件定义兼容边界、质量门禁、单引擎架构与 K2.1–K2.4 计划。

---

## 1. 先定义“兼容”

不能把三个层混成一个：

| 层 | 目标 | 判据 |
|---|---|---|
| **CLI 契约** | 必须兼容 | 子命令、退出码、`--json` 字段、`--full/--bytes` |
| **检索质量** | 必须不倒退 | 必召回、recall@3、zero-hit、top1 不降 |
| **数据/插件契约** | 真正目标 | 索引 schema、query 原语、稳定输出 schema |

**不要求**：命中顺序逐字一致。旧实现的排序依赖域知识（规则/场景卡），逐字一致等于把域搬进 dia。
**要求**：旧实现能命中的 query，dia 不能变成零命中；answerable golden 上 zero-hit 必须为 0。

---

## 2. grill 发现的真问题

| # | 问题 | 证据 | 结论 |
|---|---|---|---|
| G1 | `query` 把整句当 FTS phrase，fallback 按 token 数排序 | `search()` 引号 phrase + `LIKE '%q%' ORDER BY tokens DESC` | 中文长句结构性零命中；top1 上不去 |
| G2 | 索引缺失被当成“零命中” | `openDb` 新开空库；`search` 不校验 `docs`/`indexed_at` | 假零命中，必须 unknown |
| G3 | 非原子建索引 | `DROP` 后逐条 insert，无事务/无 rename | 并发读可见空/半截 |
| G4 | 9 条样本不足 | top1 ±1 就翻盘；旧 zero-hit 在全量 query 中 23.5% | 至少 40 条，最好 100 条 |
| G5 | 双跑只看 exit code | `yan-kb-engine.test.sh` 只验调用 | 必须比较路径集合/必召回，不得静默 pass |
| G6 | 索引正文落在 `~/.cache` | 全量正文、明文、路径不可配 | 迁到可配数据根；public 前审核 |

---

## 3. 目标架构

```text
yan-kb (domain adapter, 留 yan-agent)
  ├─ scene/rule/auto/claims/baseline/alerts/record   → domain mjs
  ├─ index/get/lint/review/path                      → dia kb
  └─ query:
       generic query → dia kb query
       scene/rule     → 生成 dia 查询原语（--id / --weight），不重排

dia packages/kb (single engine)
  ├─ query planner: 归一化 → ID 直通 → term AND/OR → FTS / fallback → 加权排序
  ├─ index: meta(schema/docs/built_at/max_mtime/tokenizer/root_hash)
  ├─ atomic build: temp db + transaction + rename
  └─ output: engine_version + hits[{path,score,why,tier}] + index{...}
```

**单一引擎铁律**：迁移期后，query 算法只能存在于 `packages/kb`；`yan-kb` 不得保留第二份打分。
`YAN_KB_ENGINE` 改名/收窄为 `YAN_KB_QUERY_ENGINE=old|dia`，只控制 query；`index/get/lint` 固定 dia。

---

## 4. 质量门禁（切默认前必须全绿）

### 4.1 golden 集

- 从真实调用抽 **60 条 query + 20 scene/rule + 20 对抗样本（短词/同义/跨域）**；
- 两人独立标 expected，分歧仲裁；
- 原始 query 只放域数据根；dia 仓只存 hash + 结构性断言。

### 4.2 指标

| 指标 | 门槛 |
|---|---|
| 必召回（旧有命中 → dia 不得零命中） | **100%** |
| answerable golden zero-hit | **0/40** |
| recall@3 | ≥ 旧基线，且 ≥0.90 |
| top1 | ≥ 旧基线；目标 ≥0.75（40+ 样本） |
| MRR | ≥0.75 |
| p95（热、端到端） | ≤60ms |
| 冷首查 | ≤400ms |
| 输出 token/次 | 中位 ≤ 旧值 +20% |
| 确定性（3 次 Jaccard） | ≥0.9 |

### 4.3 kill criteria

任一触发 → **停止切默认**，保留旧 query：

- top1 改善 <5pp 或 recall@3 <0.90；
- 任何旧有命中变 dia 零命中；
- p95 热 >80ms 或冷首查 >500ms；
- 索引 >30MB 或 109 篇构建 >1s；
- 并发读出现空/半截；
- 输出 token 中位 >旧+20%。

---

## 5. 分阶段

| 阶段 | 动作 | 门禁 |
|---|---|---|
| K2.1 | 修索引语义：meta 校验、原子构建、缓存目录可配；query 缺索引报 unknown | 空/陈旧/并发矩阵全过 |
| K2.2 | query planner：ID 直通、term OR 退阶、BM25 + title/tags/path 加权 | 40+ golden 指标达标 |
| K2.3 | yan adapter：query 双跑 + diff 报告；默认仍 old | diff 可归因；无静默降级 |
| K2.4 | 切默认并删除旧 query 实现（或冻结为显式 fallback，限期） | 一周真实使用无回归 |

---

## 6. 必须拍板的 3 个决策

1. **兼容定义**：接受“契约 + 质量”而非“命中顺序逐字一致”。（推荐）
2. **单引擎死线**：给定日期前 query 只保留 dia；不切须书面 blocker + 新日期。
3. **域语义归属**：scene/rule/claims 不迁 dia；只给 dia 两个通用原语 `--id` 与 `--weight`，等第二个域消费者再抽 `kb-policy` 包。

---

## 7. 不做什么

- 不把 scene/rule/claims/record 搬进 `packages/kb`；
- 不为排序一致复制一份旧算法；
- 不用 9 条样本做切换结论；
- 不在索引缺失/陈旧时返回空列表冒充“无命中”；
- 不先做 K2.4 再补 K2.1/K2.2。
