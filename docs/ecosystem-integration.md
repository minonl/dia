# 生态与组合：可复用性调研（2026-10）

> 日期 2026-10-28。问题：dia 的包和集成面应该长什么样，才能同时服务 opencode / dsh（未来 OpenClaw/Hermes/Pi）？
> 结论先行：**没有可执行插件的统一 ABI；唯一跨家通用的是 `SKILL.md`。跨家项目全是"manifest → codegen"，且都很年轻。dia 只做两只宿主 + codegen。**

---

## 1. 五家扩展模型

| 宿主 | 插件形态 | 技能形态 | 安装 | 版本/锁 | 证据 |
|---|---|---|---|---|---|
| **opencode** 2.1.3 | JS/TS 包（V2 分 server/tui/gui/rpc 四 part）；npm 或本地目录 | AgentSkills 目录（`.opencode/skills`、`.claude/skills`、`.agents/skills`） | `opencode plugin add/list/check/update/remove` | 精确版本即 pin；无签名（未找到） | A（本机 help + 官方 docs） |
| **OpenClaw** | 代码包 `openclaw.plugin.json`，可自带 skills | AgentSkills + `metadata.openclaw`（gating/installer） | `openclaw plugins install`、`skills install` | `.clawhub/lock.json` + `--pin` + digest | A/C |
| **Hermes** | Python 目录 `plugin.yaml` + `__init__.py`；平台插件在 `plugins/platforms/` | `.hermes/skills`、`.agents/skills`（需 trust） | `hermes plugins install`；skills `search/update/tap` | **40 位 commit SHA 钉死**、official/verified/community 分级、`removed.yaml` | A |
| **Pi** | TS extension（jiti 同进程加载） | `~/.pi/agent/skills`、`.agents/skills` | `pi install npm:@x@1.2.3` | project trust + tag | A |
| **dsh** 0.2.1-rc.2 | bundle = npm/本地包 + `cordis.patch.yml` 声明层（纯声明可无代码） | 自有 skills 目录 + skill-discovery 插件 | `dsh plugin --profile P add <pkg>`（转发 pnpm）；plugin_manager 每次审批 | `pnpm-lock.yaml` | A（本机源码） |

**关键事实**：
- opencode **V1→V2 是断代**（"V1 implementations do not run in V2"），配置键与 hook API 全变。
- Pi 的扩展**与宿主同进程、同 OS 权限**（官方 security.md 自认）。
- dsh 的 bundle 可以**纯声明**（只有 `cordis.patch.yml`，无代码），也可以带 npm 依赖；yan 已用它装了 5 个包。
- 本机 dsh 事故（yan 侧记录）：patch 覆写 preset 会导致全部 agent 掉工具，需冷启动。

---

## 2. 跨家复用项目（都在很早期）

| 项目 | 连接 | 机制 | ★ / 下载 | 日期 | 备注 |
|---|---|---|---|---|---|
| **AgentPlugins**（sigilco，Apache-2.0） | Claude / Codex / OpenCode / Pi | 统一 manifest → 生成各家插件 | 11★ / npm 11 周下载 | 2026-10-08 | 目标最接近我们；**不含 dsh** |
| **everyharness** | 12 家（含 Hermes/OpenCode/Pi） | manifest + drift validate | 38★ / 10 周下载 | 2026 | 有 validate 概念，可借鉴 |
| **plugsdk** | 多宿主 | 18 类 hook 抽象 | 101 周下载 | 2026 | — |
| **pluxx** | MCP → 4 家 | 把 MCP 转成宿主原生 | 小 | 2026 | — |
| **Tome** | 17 家 | MCP + rules | 小 | 2026 | — |
| **rulesync** | OpenCode / Claude 等 | 配置/规则**双向同步**（非可执行插件） | **1558★** | 2026-10-27 | 成熟度最高，但只同步配置，且有损 |
| `hermes-opencode-acp` | Hermes ↔ opencode | `opencode acp` 子进程后端 | 10★ | 2026 | 本文档 §4 |

**结论**：
1. **可执行插件没有统一 ABI**，所有跨家方案都是"编译/生成"，不是"运行时加载"。
2. 这些项目全在 10–40★ 量级，**唯一成熟的是配置同步（rulesync）**。
3. **没有任何项目支持 dsh** —— 这是我们的空位，但空位小，不值得为它发明标准。

---

## 3. 安装与信任（决定包设计）

| 宿主 | 安装时是否执行代码 | 签名/哈希 | 已知事故 |
|---|---|---|---|
| opencode | **是**（npm 启动即执行） | 无（未找到） | #59251 插件名被当包安装、#58574 静默丢弃、#58045 V2 模块无效 |
| OpenClaw | 是（installer 真跑 brew/npm/go/uv/download） | ClawHub digest + pin | **ClawHavoc**：341→824 恶意 skill，靠"伪造前置依赖"诱导执行 |
| Hermes | 是 | SHA pin + 分级 + 拉黑 + capability 声明 | Desktop 插件**无沙箱** |
| Pi | 是（同进程） | project trust | 官方："full system access" |
| dsh | 是（pnpm） | lockfile | patch 覆写 preset 事故 |

**对 dia 的硬规则**：
- 包**默认无执行权**；安装只落盘（不跑 install script）。
- 必须声明 `capabilities`（tools/hooks/env/network），启用需人工批准。
- 内容哈希进 `dia.lock`；`dia persona verify` / `dia kit verify` 可复现。

---

## 4. 集成面：ACP 是事实标准，MCP 只是工具层

### 4.1 ACP 服务端（谁能被驱动）

| 宿主 | 入口 | 状态 | 证据 |
|---|---|---|---|
| opencode | `opencode acp`（stdio） | 官方，可用 | A（本机 help） |
| OpenClaw | `openclaw acp`（stdio → Gateway WS） | 官方；`loadSession` 部分实现、per-session MCP 不支持 | A |
| Hermes | `hermes acp` | 官方，可用 | A |
| dsh | `dsh-acp-app`（JSON-RPC stdio） | 官方包；社区另有 `deepseek-harness-acp`(53★)、`dsh-acp-interactive`(87★) | A/C |
| Pi | 需 `pi-acp`（747★，MVP）→ 内部 `pi --mode rpc` | 社区，可用但会小破坏 | C |

### 4.2 ACP 客户端（谁能驱动别人）

- **openclaw/acpx（3395★，MIT）**：通用 ACP 客户端，内置 `opencode`（`npx opencode-ai acp`）、`pi`（`npx pi-acp`）、`openclaw` 目标。**这是最成熟的一块，不该重写。**
- 编辑器/客户端生态：Zed、`vscode-acp`(406★)、`obsidian-agent-client`(2462★)、`acp-ui`(502★)、`agentic.nvim`(643★)、`wechat-acp`(851★)。
- SDK：TS(266★) / Python(341★) / Rust(230★) / Kotlin(97★) / Java(78★)，另有 TCK。

### 4.3 编排器（多引擎）

| 项目 | 连接 | 机制 | ★ | 状态 |
|---|---|---|---|---|
| **AionUi** | OpenClaw/Hermes/opencode/Pi + 20 余 CLI，Team Mode | ACP + MCP stdio | 33832 | 桌面应用，可用 |
| **orca** | Codex/Claude/opencode/Pi，每任务独立 worktree | CLI + worktree | 108130 | 可用 |
| **cc-switch** | 五家 provider/MCP/Skills 配置 | 纯配置渲染 | 149424 | 可用（不是桥） |
| **codeg** | 20 个 agent + 任意 ACP，会话聚合 | ACP + 结构化渲染 | 4156 | 可用 |
| **claw-orchestrator** | 六引擎含 dsh | `engine:'acp'` 预设 + 验收判据 | 601 | 可用 |
| **harness-remote** | 六家，远程接管原生 session | 会话控制面 | 425 | 可用 |

### 4.4 空位（没人做）

1. **Hermes ↔ dsh / Pi ↔ dsh / Hermes ↔ Pi**：没有专用桥。
2. **跨引擎会话移交**（A 引擎的 session 交给 B 续跑）：只有 `harness-remote` 在单引擎内做。
3. **纯 CLI 的多引擎团队编排**：AionUi 是桌面应用，其余多是单任务启动器；**没有一个"无 GUI、按角色分工、带验收判据"的 CLI 编排器**。

### 4.5 风险

- `acpx` 自述 **pre-1.0**，CLI 会变。
- `pi-acp`、dsh 的两个 ACP 桥都是单人/低星项目，不能当硬依赖。
- **ACP 同名歧义**：Agent Client Protocol vs Virtuals 的 Agent Commerce Protocol（后者 `openclaw-acp` 已废弃）。选型只认 `agentclientprotocol`。

### 4.6 对 dia 的位置

- **先做 ACP server**（能被任何客户端驱动），而不是自己实现 client 去驱动五家。
- 需要调用别人时，**用 `acpx` 作为外部可执行**，dia 只负责策略/审计/会话记录，不内嵌 ACP 协议栈。
- dia 的机会是 **4.4 的第 3 条**：CLI-only、按角色、带验收判据的编排——但这是"编排层"，不是框架核心，应放在 dia 之上而不是 dia 里面。

## 5. Persona / Kit 格式（v0）

```
persona/
├── dia.json                  # schema/kind=persona/id/version/hosts/capabilities/entry/kits
├── agents/<id>.md            # opencode agent
├── platform/dsh/<id>-persona/  # dsh bundle
└── dia.lock                  # 生成物：逐文件 sha256

kit/
├── dia.json                  # kind=kit
├── skills/<name>/SKILL.md    # AgentSkills 原样
├── knowledge/**.md
├── bin/                      # 可选工具（默认无执行权）
└── dia.lock
```

命令：

```
dia persona add <id> --from <git-url> --ref <sha>
dia persona render <id> --host opencode|dsh
dia persona verify|remove|list
dia kit add|verify|remove|list
```

**渲染而非运行时适配**：只维护 opencode 与 dsh 两只宿主；每次 render 比对哈希，宿主 API 变了就重渲染，而不是写兼容层。

## 6. 明确不做

1. 不做运行时插件适配层（opencode V2 仍在动，等于给自己加第二个漂移源）。
2. 不做公共市场（ClawHavoc 的教训）。
3. 不为 dsh 发明私有标准；dsh 就用它的 bundle 格式。
4. 不在安装时执行任何脚本。

---

## 7. 待验证 / 缺口

| 项 | 状态 |
|---|---|
| dsh bundle 的 `cordis.patch.yml` 完整 schema 与冲突规则 | 部分（本机 yan-preset/watchdog 可参考） |
| opencode V2 插件 API 的稳定性 | 已知在动（三条 issue） |
| ACP client 侧成熟度 | 仅社区项目（10★） |
| 跨家可执行插件的真实需求 | **未验证**（没有用户案例） |

> 结论：**包格式现在就该定，但只做"manifest + skills + knowledge + lock"四件；执行交给宿主的原生机制。**
