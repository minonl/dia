# 框架启动方案（bootstrap）

> 日期 2026-10-27。配合 `docs/architecture.md`。
> 目标：先把"会话采集 + 知识检索"这条最小闭环跑起来，再谈其他。

## 1. 仓库与分发

### 1.1 布局

```
framework/
├── bin/dia.js                # 唯一入口（Node/Bun）
├── packages/                 # TS 包：core / kb / job / cli
├── packages/                 # 内置包（可选）
├── tests/                    # unittest + shell
└── docs/
```

### 1.2 分发选项

| 方案 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| **A. GitHub Release tarball + `install.sh` + sha256** | 零依赖、离线可用、私有仓用 `gh` 下载、版本可钉 | 需要 `gh` 或 token；无自动更新 | **当前首选** |
| B. 私有 npm（GitHub Packages） | 版本语义清晰、可锁 | 需要 npm 登录与 token；对 bash/TS 项目是多余依赖 | 以后出 TS 插件时 |
| C. 公开 npm | 安装最省事 | 代码公开 | 若决定开源 |
| D. git submodule / subtree | 无发布流程 | 两个域版本耦合，回滚困难 | 不推荐 |

**推荐 A**：`gh release download <tag> -R <org>/framework` → 解压到 `~/.local/share/framework/<version>` → `~/.local/bin/agentctl` 软链。
每个域持有 `framework.lock`：`{version, sha256}`；`agentctl self-check` 校验完整性。

## 2. 第一个任务：会话采集（ingest）

### 2.1 输入（本机实测）

| 源 | 位置 | 规模 | 读取方式 |
|---|---|---|---|
| dsh | `~/.dsh/sessions/<escaped-workspace>/session-<uuid>/session.v4.jsonl.zstd` | 241 个 / 146MB | `node:zlib` zstd 流式解压后逐行 JSON |
| opencode | `~/.local/share/opencode/opencode.db`（SQLite） | 449MB / 34 会话 / 7377 消息 / 30201 片段 | `sqlite3` **只读 URI**，按 session 逐条流式读 |

依赖兜底：`zstd` CLI 优先；没有则用 Python ≥3.14 的 `compression.zstd`；都没有 → 跳过并写 `degraded_reason`。

### 2.2 流程

```
读 → 脱敏 → 归一（episode）→ 去重 → 候选
```

- **脱敏（必须先于落盘）**：token/密码/私钥/内网域名/邮箱/手机号/工号 → 占位符。
  规则集放 `rules/redact.txt`，每条形如 `正则 → 标签`；样例集 100 条，命中率与误伤率进测试。
- **归一 schema**：
  ```json
  {"schema_v":1,"episode_id":"sha256","source":"dsh|opencode","domain":"dabo|yan",
   "workspace":"<hash>","project":"<hash|null>","workspace_id":"<id|null>",
   "directory_hash":"<hash>","path_hash":"<hash>",
   "ts_start":"...","ts_end":"...","turns":N,
   "tools":[{"name":"bash","count":2,"ok":1}],
   "summary":"<脱敏后摘要>","raw_ref":"<source>:<session-id>"}
  ```
- **不存原始消息**：只存脱敏摘要 + 指针；要看原文按 `raw_ref` 回源（默认关闭）。
- **去重**：`episode_id = sha256(source|session_id|first_ts|last_ts)`；同一会话重跑不重复。
- **候选**：只产出 `candidates.jsonl`（"可能值得沉淀的做法"），**不自动写知识库**。

### 2.3 域与隐私

| 域 | 默认 | 说明 |
|---|---|---|
| dabo | **开** | 个人会话，默认采集 |
| yan | **关** | 工作会话，需 `--domain yan --i-own-this` 显式开启；产物不出本域 |

跨域只共享**方法**（代码/规则），不共享**数据**（episodes 分目录、不同密钥可选）。

### 2.4 判据

1. 能列出两个源的会话总数与时间范围，且与源一致（±0）。
2. 抽样 20 个 episode：`raw_ref` 能回源、时间戳落在原会话区间内。
3. 脱敏样例 100 条：命中率 100%，误伤 <5%（误伤 = 正常文本被替换）。
4. 同一输入跑两遍：`episode_id` 集合完全一致（幂等）。
5. 只读验证：跑完后源文件 mtime 与大小不变（`stat` 前后对比）。
6. 无网络：`ingest` 期间零出网（用 `lsof` 或审计断言）。

## 3. 第二个任务：知识检索（kb）

最小接口：

```
agentctl kb index [--root <dir>]        # 重建派生索引（可重复执行，结果哈希一致）
agentctl kb search "<q>" [--tag ...]    # FTS5 检索，返回路径+片段
agentctl kb lint                        # 索引覆盖/断链/复审到期/超预算
agentctl kb get <path> [--section ...]  # 取正文（按需读）
```

判据：
- 与 yan 现状抽样 20 条查询结果一致（路径集合相同，顺序可不同）；
- 删除 `index.db` 后重建两次，`sha256` 一致；
- lint 能准确报出当前 yan 库的 29 个未索引文件与 9 条断链（作为基线测试）。

## 4. 首个里程碑（1–2 天）

1. 建 framework 私有仓 + 骨架 + CI（ubuntu + macos）。
2. `agentctl kb index/search/lint` 指向 yan 知识目录（只读），跑出基线数字。
3. `agentctl ingest` 采集 dabo 域会话（先小样本 5 个），产出脱敏 episode。
4. 把上面 6 条判据写成测试。
