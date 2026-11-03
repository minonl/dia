# yan-kb → dia kb：能力矩阵与迁移计划

> **v2 修订（2026-10-30）**：兼容边界、质量门禁、单引擎架构见 [`yan-kb-parity.md`](yan-kb-parity.md)。
> 本文的 K2 仅保留为历史阶段；query 切换必须先过 v2 的 K2.1–K2.3。

> 日期 2026-10-30。回答：**当前 dia kb 能替代 yan-kb 的哪些工具？**
> 结论：能替代 `index/get/lint` 的通用部分；`query` 需要补 parity；
> `scene/rule/auto/claims/baseline/alerts/record/scene sync` 是 yan 域语义，不迁 dia，也不单独建仓。

---

## 1. 计划原文（先对齐）

`docs/architecture.md`：

- §2 职责矩阵：**知识索引 / 检索 / 复审队列 → framework**；域只提供知识。
- §3 存储：md 唯一事实源；sqlite **派生索引**；检索、复审队列、断链、覆盖统计由工具生成。
- §4 抽取顺序：定义契约 `kb search/get/lint` → framework 最小版 → **先切 yan-kb 的检索** → dabo → kit。
- 判据：同一查询 20 条结果集一致；索引重建哈希一致；yan 一周无回归。

`docs/history/framework-bootstrap.md` §3：

```text
kb index [--root]
kb search "<q>"
kb lint
kb get <path> [--section]
```

所以计划从一开始就是：**framework 接管通用 KB 工具，yan-kb 保留域编排**。不是把整个 `yan-kb` 搬进 dia。

---

## 2. 当前实现对照

dia `src/kb.ts` 现在只有：`index / search / lint / get`。

| yan-kb 工具 | dia 现状 | 能否替代 | 说明 |
|---|---|---|---|
| `query "<意图>"` | `search` | ⚠️ 部分 | dia 是 FTS/LIKE；yan 有意图路由、排序、digest/full、observe |
| `--scene` / `--scene-list` | 无 | ❌ | 场景卡属于 yan 知识语义 |
| `--rule <ID>` | 无 | ❌ | 规则 ID 解析属于 yan 知识语义 |
| `--auto "<一句话>"` | 无 | ❌ | dispatch/场景路由属于 yan |
| `path <addr>` | 无 | ⚠️ 可抽 | 知识地址解析可做通用契约 |
| `claims` | 无 | ❌ | 承诺台账是 yan 域 |
| `baseline` / `alerts` | 无 | ❌ | dispatch 基线/告警是 yan 域 |
| `report` / observe | 无 | ⚠️ 可抽 | 调用观测是通用 telemetry，但 schema 未定 |
| `record gap/decision/note` | 无 | ❌ | 写知识是域策略；不能进 framework 默认写 |
| `scene sync` | 无 | ❌ | 场景不变量是 yan 域 |
| `doctor` | 无 | ❌ | yan 组合自检 |
| `index` | ✅ | ✅ | 通用 |
| `lint` | ✅（基础） | ⚠️ 部分 | dia 有覆盖/复审/断链；yan 还查 scene/rule 引用、承诺等 |
| `get` | ✅ | ✅ | 通用 |

**一句话**：`index/get` 可直接替代；`lint` 替代基础部分；`query` 是下一个 parity 项；其余是域语义，不该进 dia。

---

## 3. 修正后的迁移计划

### K0：冻结查询集（无模型，1 天）✅

- 从 yan 真实 `kb-calls.jsonl` 抽 20 条查询（含 scene/rule/auto）；
- 记录 `path 集合 + 顺序 + exit code` 为 golden；
- 只读，不改 yan。

### K1：dia kb 补通用契约 ✅

- ✅ `dia kb query`：兼容 `search`，加 `--json/--full/--bytes`；
- ✅ 复审队列：`dia kb review`（缺失/到期/stale）；
- ✅ `dia kb path`：doc/workflow/skill/tool 地址 → 绝对路径；可配 `--repo/--skills-dir`；
- `dia kb observe/report`：可选；先定义 JSONL schema，不急着迁。
- 判据：20 条查询路径集合一致；索引重建两次哈希一致。

### K2：yan-kb thin shim（进行中）

```text
yan-kb index   → exec dia kb index --root <yan-core/knowledge>   ✅
yan-kb lint    → exec dia kb lint --root ...                     ✅
yan-kb get     → exec dia kb get --root ...                      ✅
yan-kb query   → 默认旧实现；YAN_KB_ENGINE=dia 显式走 dia       ⚠️ parity 未达
yan-kb --scene/--rule/--auto/claims/baseline/alerts/record → 本地实现（不动）
```

> 2026-10-30 实测：`YAN_KB_ENGINE=dia` 对真实 query `R30.5 评审请求消息模板` 返回空，
> 旧实现有 R33 命中。因此 **query 默认继续走旧实现**，K2 只完成 index/get/lint 路由；
> query parity 归入 K2.1，不得切默认。

- 不复制实现；`yan-kb` 只做路由和域参数；
- `index/get/lint` 已切；`query` 双跑显示路径/语义未对齐，暂不切默认。

### K3：一周双跑 + 回滚

- 同一查询新旧输出对比；
- `YAN_KB_ENGINE=old|dia` 开关；
- 有回归立即切回；一周无回归才默认 dia。

### K4：只有 dabo 也需要 scene/claims 时才抽包

- 抽 `kb-policy`（私有包）而不是 `yan-kb` 整仓；
- 否则 scene/claims 永远留 yan-agent@next。

---

## 4. 边界

**迁 dia**：index、query/search、get、lint 基础项、review queue、path、observe（schema 稳定后）。

**留 yan-agent@next**：scene、rule ID、auto dispatch、claims、baseline、alerts、record 写入策略、scene sync、doctor。

**不建 `yan-kb` 独立仓**：它不是一个通用工具，而是“dia kb 引擎 + yan 知识语义”的组合入口。独立会把 yan 的 scenes/rules/claims 一起拖走，dabo 又不需要。

---

## 5. 下一步

1. 先做 K0：20 条真实查询 golden；
2. ✅ K1 `dia kb query/review/path` 已完成；
3. K2 只切 `query/index/get`，`--scene` 等不动；
4. 每次变更附命令与输出，不用“应该可以”结案。
