# dia Public Release Gate

> 状态：**已公开（2026-11-05）；2026-11-27 复核：当前树已脱敏，历史仍 blocked（见 §5/§6）**。
> main 树与公开分支 HEAD 均已脱敏；pre-push 守卫已加敏感扫描 + 私有词表。
> **残留**：不可达旧 commit 对象需 GitHub Support GC（公开前已存在的缓存）。
> 门禁保留为「未来发布前」的检查清单。
>
> 2026-11-05 实际路径：重建历史（filter-branch 清洗内部标识）→ 删库重建（新仓库 ID）→ 转 public → 开 Pages。
> 旧的 `dia-archive-private` 已删除；npm `@minonl/dia` 已发布（OIDC）。
>
> 2026-11-04 更正：**发 npm 不需要仓库公开**（Trusted Publishing 对私有仓可用）；只有 **provenance** 需要公开仓。
> 所以「发 npm」与「转公开」不是同一道门：私有仓可先发不带 provenance 的版本，公开后再补 provenance。
> 适用：把 `minonl/dia` 从 private 改为 public 之前。任何一项失败都不得公开。

---

## 1. 硬门禁

| # | 项 | 通过条件 |
|---|---|---|
| 1 | 当前树脱敏 | 无凭据、PII、公司/内部域名、家目录、内部仓库链接、业务知识 |
| 2 | Git 历史清洁 | 所有 ref 可达历史扫描通过；旧敏感对象不可达；tags/releases 已清理 |
| 3 | GitHub 元数据 | 仓库描述、topics、Actions 日志、releases、issues/PR、wiki 无内部信息 |
| 4 | 配置 | provider/baseURL/token 全部走 env 或通用占位符，无硬编码 |
| 4b | 运行时 | 无 Python 依赖；`packages/job` 的 JSON 层迁到 Node/Bun（见 `docs/migrations/no-python.md`） |
| 5 | 打包 | `private` 仅在 audit 通过后移除；lockfile/registry 无私有源；无 source map 泄漏 |
| 6 | 文档 | 内部迁移文档移出 public 仓或脱敏；示例全部通用化 |
| 7 | 政策文件 | `LICENSE`、`SECURITY.md`、漏洞报告渠道就绪 |
| 8 | 独立审核 | `dia-security` agent 出 `pass` 报告 + 人工签字；自签无效 |

---

## 2. 安全审核 agent

定义：`team/agents/dia-security.md`。只读、不得改文件、不得执行写操作。

输出必须是 JSON：

```json
{
  "verdict": "pass|blocked|unknown",
  "scope": "commit/tag",
  "findings": [
    {"id": "...", "severity": "P0|P1|P2|P3", "area": "tree|history|metadata|config|package|docs", "evidence": "...", "fix": "..."}
  ],
  "history_clean": true,
  "public_ready": false
}
```

规则：

- 任一 P0/P1 → `blocked`；
- 无法扫描（缺工具/权限/历史不完整）→ `unknown`，不得算通过；
- 发现即记录证据文件 `docs/security/audits/<date>.json`（不含 secret 原文）。

---

## 3. 扫描清单（通用模式）

> 文档不写具体公司词；审核时用内部词表，不把词表提交进 public 仓。

### 3.1 当前树

- 凭据形态：API key/token/私钥/`.env`/`opencode.db`/`session*.jsonl`
- 内部标识：公司名、内部域名、内部仓库 URL、工号、组织 ID
- 个人信息：`/Users/<name>`、`/home/<name>`、邮箱、手机号
- 业务知识：工作域规则、客户/商品/组织数据、内部项目名
- 配置：硬编码 provider/baseURL/token；测试夹具中的真实值

### 3.2 Git 历史

```sh
git rev-list --all --count
git log --all --oneline
git log --all -p | <scanner>
git rev-list --all --objects | <object-scanner>
git tag -l
git for-each-ref
```

- 旧敏感 commit 必须不可达（重建历史或 filter-repo）；
- force push 后仍需向 GitHub Support 申请 GC/purge，避免缓存对象；
- 检查 tags/releases/annotations，不只 branch。

### 3.3 GitHub 元数据

- repo description/topics
- Actions run logs 与 artifacts
- Releases / tags / packages
- Issues / PR / wiki / discussions
- Deploy keys / webhooks / collaborators（公开前最小化）

---

## 4. 公开顺序

1. 当前树脱敏 + 测试全绿；
2. 重建/过滤历史；本地 `git grep` + 全历史扫描通过；
3. 安全审核 agent 出报告；人工复核签字；
4. force push + 申请 GitHub GC；
5. 再扫一次远端 HEAD 与 tags；
6. 最后才把 visibility 改为 public。

任何一步发现敏感项：回到 1，不跳过。

---

## 5. 当前状态（2026-11-27 复核）

- 仓库已 **public**（2026-11-05）。
- **当前树**：已脱敏；`0.1.8` tarball 扫描 0 命中；`git grep` 门禁为空。
- **Git 历史**：**未清洁**；main 历史仍有 7 个提交含旧标识（品牌 / 域名 / 仓库组 / 项目名 / 家目录）。
- **npm**：`0.1.6` 已撤回；`0.1.0–0.1.5` 已 deprecate（超 72h，tarball 仍可下载，需 npm support 才能删）。
- **防复发**：pre-push 新增私有词表（`$DIA_SENSITIVE_FILE`，默认 `~/.config/dia/sensitive.txt`，**不入仓**），任何文件类型命中即阻断。
- 结论：**当前树 pass；历史 blocked**。转 visibility / 发版前仍需处理历史。

---

## 6. 2026-11-27 事件记录（脱敏回补）

1. 发现：公开仓当前树 20+ 文件仍含内部品牌 / 内网域名 / 仓库组 / 项目名 / 家目录；main 历史 7 个提交命中。
2. 处置：
   - 当前树机械脱敏（#259）→ `0.1.7`；
   - pre-push 私有词表（#261）→ `0.1.8`（`latest`）；
   - npm `0.1.6` unpublish；`0.1.0–0.1.5` deprecate。
3. 残留：
   - Git 历史未重写（重写会改所有后续 SHA/tag，并使 `0.1.x` 的 npm provenance 指向失效提交）；
   - `0.1.0–0.1.5` tarball 仍可下载；
   - PR #259 的 diff 页面会展示被删除的旧标识（内容本已公开）。
4. 待决策：历史重写 vs 接受；npm support 申请；其他已 adopt 仓重跑 `dia wt adopt --apply`。
