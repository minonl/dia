# ACP 集成与降级设计（2026-10）

> 日期 2026-10-28。问题：通过 ACP 是否更好？fallback 怎么做？配置失败如何降级、体验如何？
> 结论：**ACP 做主通道（会话级控制），CLI/HTTP/只读做分级回退；所有降级必须显式可见，不许静默。**

---

## 1. ACP vs 其他接法

| 接法 | 能做什么 | 稳定性 | 适用 |
|---|---|---|---|
| **ACP（JSON-RPC stdio）** | 会话创建/提示/事件流/权限请求/恢复/分叉 | 协议 v1，仍在演进 | **交互式会话、跨宿主** |
| CLI one-shot | 单次任务、退出码 | 高 | **基准/canary/批处理** |
| HTTP API | 任意操作（opencode `api`） | 中（daemon 版本绑定） | 查询/管理 |
| 只读会话库 | 观察历史 | 最高 | **采集/审计** |
| 插件 hook | 深层拦截/观测 | 低（API 断代） | 仅观测 |

**为什么 ACP 更好**：它把"会话"作为一等对象（new/prompt/update/permission/resume/fork），跨 opencode/dsh 通用；CLI 只能拿最终文本，HTTP 绑定单个宿主。

**为什么不能只用 ACP**：批处理/canary 用 one-shot 更稳；观察历史不该依赖运行时；ACP 客户端本身可能坏。

---

## 2. 本机实测（2026-10-28）

| 宿主 | 启动 | initialize | session/new | 关键能力 |
|---|---|---|---|---|
| **dsh**（`@deepseek-ai/dsh-acp-app`） | `dsh --profile dia-acp` 常驻等输入 | ✅ protocolVersion 1，agentInfo `deepseek-harness-acp 0.0.1` | ✅ 返回 sessionId + configOptions | session close/list/resume；mcp http；prompt 不支持 image/embedded |
| **opencode**（`opencode acp`） | 常驻 | ✅ protocolVersion 1 | ✅ 返回 sessionId + configOptions | loadSession/fork/delete/list/resume；mcp http；prompt 支持 image/embedded |

**实测坑（必须处理）**：

1. **dsh stdout 会混入日志**：`[llm-deepseek-account] model listing ...` 出现在 JSON 之前 → 客户端必须**逐行过滤非 `{` 开头**，并为协议行设超时。
2. dsh `session/new` 会触发模型目录网络请求；离线时可能阻塞/失败 → 需要超时 + `degraded_reason`。
3. 两个服务端都**不主动输出**，必须先发 `initialize`；握手超时 = 不可用。

---

## 3. Fallback 阶梯（显式，不静默）

```
L0 ACP（首选，会话级）
  ↓ 握手失败/超时/协议错
L1 CLI one-shot（`dsh headless` / `opencode run`）
  ↓ 命令缺失/版本不符
L2 HTTP API（opencode `api`）
  ↓ 服务未运行/鉴权失败
L3 只读会话库（observe-only）
  ↓ 连读都失败
L4 拒绝执行（exit 30/31/32）
```

规则：
- **每一级降级都写 `degraded_reason` + 审计**；`dia status` 可见，不许悄悄换。
- **高危动作不降级**：写文件/外发/权限变更在 L1 以下一律拒绝（或转 draft）。
- **只读永远可用**：采集/审计不依赖 ACP。
- 用户可用 `--backend acp|cli|api|readonly` 强制指定；强制失败即报错，不回退。

---

## 4. 配置失败 → 怎么降级、体验如何

### 4.1 失败分类与退出码

| 码 | 含义 | 触发 | 降级 |
|---|---|---|---|
| 0 | OK | — | — |
| 2 | 用法错误 | 参数缺失 | 无 |
| 30 | **degraded** | ACP 失败已回退 | 继续，但标注 |
| 31 | 配置/鉴权 | 缺凭据、版本不符 | 停用该后端 |
| 32 | 协议 | 握手超时、非法 JSON、stdout 污染过多 | 回退一级 |
| 33 | 能力缺失 | 需要的能力不在 capabilities 里 | 拒绝该动作 |

### 4.2 用户体验（文字示意）

```
$ dia status
dsh       ACP  ok      v0.2.1-rc.2  session/new ok   (last 10-28 11:03)
opencode  ACP  ok      v2.1.3       loadSession ok   (last 10-28 11:04)
model     base stale   指纹 14 天未更新（建议 dia model incident）

$ dia run --session s1 -- bash -lc "npm test"
! ACP 不可用（handshake timeout）→ 已回退 CLI one-shot
! 本次为降级执行，写操作需人工确认
exit=0

$ dia doctor
FAIL  dsh ACP: handshake timeout (3.0s)
  → 修复：dsh --profile dia-acp --dump-config 检查 acp-app 是否在 bundles
  → 或：dia run --backend cli 继续（只读/批处理可用）
```

原则：
- **一句话说清降级**，再给**修复命令**；
- 降级后**不假装完整**：`status` 标 `degraded`，报告里带 `degraded_reason`；
- 不阻塞用户：采集/审计继续，执行转草稿或人工。

### 4.3 配置形态

```yaml
backends:
  dsh:
    prefer: acp
    acp: { profile: dia-acp, handshake_timeout_ms: 3000 }
    fallback: [cli, readonly]
  opencode:
    prefer: acp
    acp: { command: "opencode acp", handshake_timeout_ms: 3000 }
    fallback: [api, readonly]
```

---

## 5. 实现建议

1. **自己写薄 ACP 客户端**（TS，约 200 行）：只需 `initialize` / `session/new` / `session/prompt` / 事件读取 / `session/close`；JSON-RPC over stdio。
2. **容错**：逐行过滤非 JSON；握手/首事件/总预算超时；能力缓存到 `capabilities.json`（90 天）。
3. **acpx 只做对照/兜底**：`acpx`（0.21.1，MIT）可验证我们的客户端行为，不作为主依赖（pre-1.0）。
4. **配置探测**：启动时跑一次 `initialize`，把 `agentCapabilities` 落盘；能力缺失（如 image）直接标 `unsupported`，不猜。
5. **降级可测**：人为杀掉 ACP 进程 / 注入日志行 / 改坏 profile，E2E 必须看到 `degraded` 与回退路径。

---

## 6. 与现有设计的关系

- 与 `host-control-surface.md` 的 L0/L1 分层一致：ACP 是 L0 的会话接口。
- 与 `model-baseline-sidecar.md` 的 canary 一致：canary 默认走 CLI one-shot（稳），交互走 ACP。
- 与 `security-sandbox.md` 一致：降级不等于放开权限；高危动作仍需 waiver/人批。

---

## 7. 待验证

- ACP `session/prompt` 的事件流格式与权限请求（`session/request_permission`）在两家是否一致。
- dsh ACP 在离线（模型目录不可达）时的失败形态。
- 长时间会话的 resume/fork 语义（两家能力不同：opencode 有 fork，dsh 只有 resume）。
