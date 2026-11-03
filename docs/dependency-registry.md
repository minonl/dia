# 外部依赖索引与原始记录维护（2026-10）

> 日期 2026-10-28。回答两件事：**依赖怎么登记/验证/淘汰**，**原始记录怎么保留/重建/删除**。
> 依据：CycloneDX 1.7 / SPDX 3.0.1 / npm lockfile / semver / PEP 387 / PostgreSQL PITR / Prometheus storage / GDPR 17 / NIST AU-11。

---

## 1. 依赖登记（`deps.jsonl`，只追加）

每个依赖一行；**升级不改旧行，追加新行**（历史可追溯）。

| 字段 | 类型 | 必填 | 说明 | 依据 |
|---|---|---|---|---|
| `id` | `kind:name@ver` | ✓ | 全局唯一 | CycloneDX `bom-ref` / SPDX `spdxId` |
| `kind` | enum | ✓ | `host_cli / npm / bundle / endpoint / model / datastore / daemon` | CycloneDX 区分服务与组件 |
| `version` / `resolved` | str / uri | ✓ | 实际解析结果 | npm lockfile |
| `integrity` | `sha512-…` / commit | ✓（有产物时） | 内容哈希；**不能只靠名字** | npm `integrity`；semver §3 |
| `role` | `required/optional/degradable` | ✓ | 缺失时的行为 | 设计"可缺，缺了降级" |
| `fallback` | str | degradable 必填 | 降级路径 | 同上 |
| `verified_at/by/method/result/evidence` | RFC3339/str/enum/pass\|fail\|unknown/path | ✓ | **验证三元组 + 证据** | SPDX `verifiedUsing`；CycloneDX citations |
| `support` / `removal_after` | `active|deprecated|eol|unknown` / date | ✓ / deprecated 必填 | 淘汰宽限期 | npm deprecate；PEP 387 |
| `depends_on` | [id] | ✓（可空） | 依赖图 | CycloneDX dependency graph |

**局限（必须写进 README）**：SBOM 只回答"有什么、谁引入"，不回答"能不能跑"；lockfile 有 hash 无来源证明；`dpkg -V` 只做 md5 且依赖已有记录。

### 单一事实源：`docs/deps.jsonl`

一行一个 JSON 对象，**只追加**；同一 `id` 以最后一行为准（升级/复核都追加新行，不改旧行）。
字段即上表；没有的字段省略，不写占位。

```json
{"id":"host_cli:opencode@2.2.5","kind":"host_cli","version":"2.2.5","resolved":"command:opencode","integrity":"unknown","role":"required","verified_at":"2026-11-03","verified_by":"min","method":"smoke","result":"pass","support":"active","evidence":"docs/platforms/registry.json"}
```

规则：

1. `resolved` 用**可移植写法**（`command:opencode`、`~/...`），不写死某台机器的绝对路径。
2. 人读视图由 `dia doctor` 派生（`deps` 项，`--json` 给机器）；**本文不抄登记数据**。
3. `dia doctor` 判定：required 缺失 = `fail`；版本/路径漂移 = `warn`；可选未装 = note（不拉红）。
4. 追加用 `dia deps record`（`--id/--kind/--version` 必填；`verified_at` 自动填当天，`method=manual`）；
   看现状用 `dia deps list [--json]`（登记 + 实测，required 缺失 exit 2）。

---

## 2. 生命周期判据

| 步 | 判据 |
|---|---|
| 登记 | id 唯一 + source + integrity；缺就记 `unknown`，不猜 |
| 探测 | 存在 + 版本符合 + smoke 通过 → `active`；版本不符 → `degraded`；required 缺失 → **非 0 退出**（exit 30） |
| 启用 | `verified_at` ≤90 天 且 integrity 复核一致 |
| 升级 | 新 id（版本/hash 变），旧行保留；**禁止原地改写** |
| 废弃 | `support=deprecated` + `removal_after` ≥1 个 minor 周期 + 有替代 |
| 移除 | 无 inbound `depends_on` + 有回滚路径 + 写审计 |

---

## 3. 原始记录维护

```
raw（不可变，只追加） → derived（可重建索引/摘要） → pointer（可删）
```

| 策略 | 做法 | 依据 |
|---|---|---|
| 压缩 | 事件日志 + 周期 checkpoint；重建 = 快照 + 重放 | PostgreSQL PITR |
| 保留 | **按类别设期限**，不是全局一刀切；到期先降采样再删 | NIST AU-11 |
| 删除 | 加密擦除（销毁密钥）+ tombstone，不改链；不可豁免时走 GDPR 17(3) 例外 | GDPR 17 |
| 校验 | `prev_hash` 哈希链 + 每日摘要（可检出删行/回填） | 日志完整性实践 |
| 验证 | 月度 replay + **restore drill**（临时 HOME 恢复 → doctor 全绿 → 重放 N 条） | PostgreSQL PITR |

**本机现状（2026-10-28）**：dsh sessions 146MB/244 个、opencode.db 477MB/34 会话，**都没有统一保留策略**；先登记，再定 TTL。

---

## 4. 失败模式

| # | 失败 | 触发 | 对策 |
|---|---|---|---|
| D1 | 漂移 | 只按命令名探测 | 用 hash/resolved 判定，不用名字 |
| D2 | 静默升级 | unpinned + 无 hash | pin + 记录升级与验证 |
| D3 | 源被删 | unpublish | 本地镜像 + hash；弃用优于下架 |
| D4 | 哈希不符 | 内容被改 | 按篡改处理，隔离 + 审计，**不重算后接受** |
| D5 | 保留过度 | 无到期动作 | `review_by` + 降采样 + 删除演练 |

---

## 5. 对 dia 现有设计的 5 条修正

| # | 现状 | 修正 | 判据 |
|---|---|---|---|
| M1 | doctor（**待实现**）目前只看"命令在不在 + 版本" | 输出 `verified_at / method / by`；>90 天标 `STALE`；缺 integrity 标 `UNVERIFIED` | doctor 输出可被 `--json` 解析 |
| M2 | **现状：冻结只写元数据快照，不含任何文件**；目标才是打包会话 | SQLite 需 `VACUUM INTO` 或连同 `-wal/-shm` 一起打包，否则丢已提交事务 | 恢复后行数一致 |
| M3 | audit 只 append-only，无防篡改（**未实现**） | 加 `prev_hash` 链 + 每日摘要；删行/回填可检出 | 删一行后 `audit verify` 报链断 |
| M4 | 截断只留索引，无重建路径 | 截断前先落 raw 归档（只写一次）+ 定义 replay 判据 | 能从归档还原被截条目的索引行 |
| M5 | 工具只有 retired，无 deprecated 宽限 | 补 `support` + `removal_after`，禁止直接删 | 移除前必须有替代 + 回滚 |

---

## 6. 未验证 / 缺口

- SLSA provenance 逐字段（本机不可达）
- NIST SP 800-92 保留章节原文（PDF 不可读）
- Nix 输入寻址原文（未验证）
- opencode/dsh 自身是否有 TTL/GC：**未找到官方保留策略**
