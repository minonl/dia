# dia Public Release Gate

> 状态：**BLOCKED until audit**（2026-10-30）
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

## 5. 当前状态

- `dia` 历史已于 2026-10-30 重建为单提交（当前仓库继续追加干净提交）；
- 2026-11-04：当前树脱敏完成（工作域/内部域名/项目名 → 通用占位），287 tests 全绿；见 `audits/2026-11-04.json`；
- 仍待完成：历史重建（3 个提交含内部名）、独立审核报告；
- 因此**当前不得转 public**。
