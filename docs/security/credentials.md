# 凭据管理（现状 + 调研待办）

> 2026-11-03。**待调研**，不是方案定稿。触发：bw CLI 已用于入库，但"按账号分组"决定放行粒度，
> 个人 vault 内容过多、风险集中；需要找更合适的用法或替代。

---

## 1. 现状

| 项 | 现状 |
|---|---|
| 存储 | `~/.env.leyan`（网关 key）、`~/.env.leyan-tokens`（脚本凭据），600 明文 |
| 入库 | Bitwarden（`bw` CLI） |
| 使用 | `dia env list/check/run`：白名单键 → 子进程环境；不回显、`--redact`、密钥不进 argv |
| 约束 | 明文文件**不是**机密性边界（同一 OS 用户下的 agent 可读），只是"防误入 repo/日志/备份" |

## 2. 问题（为什么要继续找办法）

1. **放行粒度 = 账号 / collection 分组**：bw 的访问控制跟着账号走，没法对"某个 agent、某次任务"单独授权。
2. **爆炸半径大**：个人 vault 内容多，一次解锁等于全量暴露；agent 拿到的会话能读到的远多于它需要的。
3. **无调用审计**：bw 侧看不到"哪个任务取了哪个键"，dia 侧只看得到注入动作。
4. **解锁即长期有效**：`bw unlock` 的 session 是令牌，落在环境里就有泄漏面。

## 3. 硬约束（不能破）

- 凭据值不进 repo / 日志 / 截图 / URL / argv；只走白名单键注入。
- 每个任务只能拿它声明的键；越权即失败（显式，不静默回退）。
- 取用要可审计：谁、什么时候、拿了哪个键（不记值）。
- 失效要大声：缺键 / 解锁失败 → 非 0 退出并给修复命令。

## 4. 候选方向（待调研，未选型）

| 方向 | 要点 | 待验证 |
|---|---|---|
| bw 会话收敛 | 只在 `dia env run` 进程内 unlock，子进程退出即失效；按 collection 拆个人/工作 | `bw unlock --raw` 生命周期；是否支持按项读取 |
| OS 级隔离 | macOS Keychain / Linux Secret Service，按条目授权 | 跨平台一致性；agent 进程的访问控制粒度 |
| 分级密钥库 | 敏感域（家庭库）独立 vault / 独立 passphrase | 与 §3 审计线的组合 |
| 引用而非值 | SOPS / age / Infisical / Vault：配置里只放引用，运行时解析 | 离线可用性、CI 场景、轮换成本 |
| 短时令牌 | 临时 STS / 短 TTL token 替代长期 key | 各上游是否支持；失败重试策略 |

## 5. 调研清单（下一步）

1. 读 bw CLI 官方文档 + 社区实践：session 生命周期、`--raw`、组织/collection 权限模型。
2. 对照开源方案（Infisical、Vault、SOPS/age）在"单机 + agent"场景的最小可用形态。
3. 找公开的 agent 凭据实践（最小权限、短时凭据、审计）作为判据参考。
4. 产出一页选型对比 + 一个能跑的 POC 判据（例：`dia env run` 只拿到声明的 2 个键，未声明的键读取失败且有审计行）。

> 结论落地前，继续沿用现有 `dia env` 白名单注入；**不要在调研期引入第二套凭据路径**。

---

## 6. 调研摘要（2026-11-04）

> 来源：Bitwarden 官方 CLI 文档、trustless 的两篇 bw 自动化笔记、awesomecli 的 agent 指南、社区实践。结论只取可验证的行为约定。

**关键事实（会决定方案）**

1. **`BW_SESSION` 是 bearer 凭据**：拿到它就等于拿到该账号可见的全部 vault；只能放环境变量，**不能进 argv**（`ps`/`/proc/<pid>/cmdline` 同用户可读）。
2. **每次 `bw unlock` 会让之前所有 session key 失效**——多个任务各自 unlock 会互相踢掉。这条直接否掉"每个 task 自己解锁"。
3. `bw lock` 只锁不解登；`bw logout` 才结束身份。无人值守脚本结束应 `lock`（共享机用 `logout`）。
4. `bw serve` 等于把 vault 能力开成常驻本地服务，只在完全可控的机器上用。
5. 官方提供 `--passwordenv` / `--passwordfile`；API key 登录可给自动化独立身份与轮换周期，避免用人的主密码。

**对我们问题的直接含义**

- "按账号分组"不是实现问题，是 bw 的访问模型：**会话粒度 = 账号**。要任务级最小权限，必须自己做 broker，而不是给 agent 一个 `bw` 会话。
- 因此候选方向收敛为：**单 broker 进程持有唯一 session**（它负责 unlock/lock、按请求只返回声明的键），agent 侧永远拿不到 `BW_SESSION`。
  - 这也解释了为什么"每次放行靠账号分组"体验差：粒度根本不在 bw 这一层。
- 备选（成本从低到高）：短时令牌优先于长期 key；敏感域独立 vault；引用式（SOPS/age/Vault）只在 CI/无交互场景更合适。

**POC（2026-11-04 已实现，含常驻 broker）**

```bash
dia env bw unlock [--passwordfile P]   # session 落 0600，不回显
dia env bw status                      # unauthenticated/locked/unlocked
dia env bw run --map DB_PASS=db-item -- <cmd…>
dia env bw lock                        # 同时清本地 session
dia env bw serve                       # 常驻 broker（unix socket 0600）
dia env bw get --item db --task t-1    # 走 broker，写审计行
```

实现约束：`BW_SESSION` 只存在于 bw 子进程环境；映射外的键一律不注入；任一条取不到 → 不执行命令（fail-closed）。

**常驻化**：`packaging/launchd/` 有 broker 的 launchd 模板（RunAtLoad + KeepAlive）；前置是先 `dia env bw unlock`。

**判据（POC 验收）**

1. agent 进程环境里**没有** `BW_SESSION`；
2. 只能取到任务声明的 N 个键，未声明的键请求即失败（fail-closed，非空返回）；
3. 同一时刻起 3 个任务不会互相踢掉会话（单 broker 持有）；
4. 每次取用留一行审计（谁/哪个任务/哪个键，不含值）。
