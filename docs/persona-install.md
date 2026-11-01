# Persona / Kit 安装：用 dia 从 git 地址装

> 日期 2026-10-28。命名已定：**persona = 可被选中的 agent 定义**，**kit = 知识/技能/工具内容**，**profile = 宿主运行环境（dsh）**。
> 安装入口统一为 `dia persona ...` / `dia kit ...`，不再使用 `pkg`。

---

## 1. 命令

```bash
# 取回并注册（私有仓用现有 git 凭据）
dia persona add dabo --from git+https://github.com/minonl/dabo-agent.git --ref <sha>

dia persona list
dia persona verify dabo
dia persona render dabo --host opencode|dsh
dia persona update dabo --ref <sha>
dia persona remove dabo

# 从零创建骨架（作者轴，不是安装）
dia persona create mybot --dir ~/repos/mybot

# 内容包
dia kit add git+https://github.com/minonl/<kit>.git --ref <sha>
dia kit list / verify / remove
```

**渲染目标**：

| 宿主 | 产物 | 是否改默认 |
|---|---|---|
| opencode | `~/.config/opencode/agents/dabo.md` | **否**（用户自己切） |
| dsh | `~/.dsh/profiles/dabo/`（独立 profile，端口 3090） | **否**（`dsh --profile dabo`） |
| 记录 | `deps.yaml` + `dia.lock` | — |

原则：**只新增，不改 yan，不改默认 agent。**

---

## 2. 清单：`dia.json`（一个文件，`kind` 区分）

```json
{
  "schema": 1,
  "kind": "persona",
  "id": "dabo",
  "name": "大波（dabo）",
  "version": "0.1.0",
  "hosts": ["opencode", "dsh"],
  "entry": {
    "opencode": "agents/dabo.md",
    "dsh": "platform/dsh/dabo-persona"
  },
  "kits": ["core"],
  "capabilities": {
    "tools": ["bash", "git"],
    "network": false,
    "env": []
  },
  "requires": { "dia": ">=0.1.0" }
}
```

kit 的完整格式、渲染规则与生命周期见 [`docs/kit-install.md`](kit-install.md)（本文只留最小形态）。

kit 用同一个文件名：

```json
{ "schema": 1, "kind": "kit", "id": "core", "version": "0.1.0", "skills": ["..."], "knowledge": ["docs/"] }
```

**为什么不是 `dia.persona.json` / `dia.kit.json`**：两个文件名会让命令按名字猜类型、维护两套入口；`dia.json` + `kind` 更直接。
**为什么不是 `package.json`**：npm 语义（依赖/脚本/执行）与"安装不执行"冲突。

---

## 3. 安装管线

```
git clone --depth 1 --ref <sha> → 临时目录
  → 校验 dia.json（schema/kind/版本/宿主）
  → 计算内容哈希 → 写 dia.lock
  → 渲染：
      opencode：复制 agents/dabo.md（当前原样复制；managed-by 头待实现）
      dsh：复制 platform/dsh/dabo-persona + 生成独立 profile
  → 登记 deps.yaml（待实现）
  → 不启停服务、不改默认
```

**幂等**：同 commit 重装无变化；换 commit 先备份旧渲染产物，可 `remove` 回滚。

### 3.1 update 与 render 的区别

| 命令 | 是否换内容 | 做什么 | 何时用 |
|---|---|---|---|
| **add** | 首次 | fetch → 校验 → render → lock | 第一次安装 |
| **update** | **是**（git ref → 新 commit） | 取新版本 → 校验 → 备份旧版 → render → lock | 升级人格/内容 |
| **render** | **否** | 用已安装版本重新生成宿主文件 | 宿主升级、配置改了、渲染文件被手改/丢失 |

一句话：**update = 换内容 + render；render = 只重画，不换内容。**

`render --check` 只比对宿主文件与 lock，输出 drift，不写盘。

### 3.2 能不能热更新进行中的会话？

**看宿主能力，不一刀切**（详见 `docs/versioning.md` §3）：

| 能力 | 行为 |
|---|---|
| T3 原生增量（dsh `in-history` / opencode `agent.transform`） | 新增/移除可通知会话；可按 `--apply active` |
| T2 事件/预步 | 下一轮注入变更通知；破环性变更仍拒绝 |
| T1 工具边界 | 下次调用感知（如 MCP 登录） |
| T0 无钩子 | 只能下次会话 |

**硬规则**：破环性变更（移除工具、签名变化、换 persona 身份）**永远不静默热切**；`--activate-now` 需 `--i-am-human` 且在 T0/T1 下要求 0 活跃会话。`render` 只改文件，不触碰会话。

体验示意：

```
$ dia persona update dabo --ref <sha>
staged dabo@v2 (commit abc123)
  3 active sessions still on v1; new sessions will use v2
  apply now: dia persona update --activate-now --i-am-human (0 active required)
```

---

## 4. 安全规则

1. 来源白名单（git host + owner），防误装。
2. `--ref` 解析后把 **commit sha** 写进 lock。
3. 逐字节 sha256 只覆盖 **dia 写入且宿主不改写** 的产物（persona 内容、opencode agent md、软链）；
   **宿主自管目录**（dsh profile）只校验「目录在 + `.dia-managed` 归属」，不比字节——dsh 启动会重写
   `cordis.yml`、装插件会改 `package.json`。`verify` 失败时用 `issues` 逐条列出原因。
4. **不执行安装脚本**；dsh 插件也不在安装期执行。
5. `capabilities` 未声明的工具不授予；网络默认关。
6. `--dry-run` 显示将写入的文件与差异。
7. 卸载只删带 `.dia-managed`（id 匹配）的产物；用户手改/归属不符的目录拒绝删除并提示。

---

## 5. 配置失败/降级体验

| 情况 | 用户看到 | 行为 |
|---|---|---|
| git 不可达/鉴权失败 | `E_AUTH` + 修复提示 | 不写入任何文件 |
| 清单缺失/版本不符 | `E_MANIFEST` | 不安装 |
| 哈希不符 | `E_HASH`（按篡改处理） | 隔离，不覆盖 |
| 目标 agent 冲突 | `E_CONFLICT`（exit 32） | 不覆盖；先 remove 或手改 |
| 宿主未安装 | `W_HOST_MISSING` | 只装另一个宿主，记录 degraded |
| 默认 agent 被改 | — | **禁止**：安装器不写 default 字段 |

---

## 5.1 已实测（2026-10-29）

- `dia persona add --from ~/repos/github/dabo-agent` → 同时渲染 opencode agent + dsh profile；
- `opencode debug agents` 出现 `dabo`，**默认仍是 `yan`**；
- `dsh --profile dabo` 启动正常（webserver 3090，避开被占用的 3080）；
- yan 的 agent/profile 未改动。

## 5.2 opencode 配置：`.json` 与 `.jsonc`（2026-11-01）

opencode 从 **v0.3.100（2025-07-31，PR #1434）** 起支持 `opencode.jsonc`；
从 **v1.14.49（2026-05-13，PR #26992）** 起，没有配置时默认创建 `opencode.jsonc`。
宿主的查找顺序是 `["opencode.json", "opencode.jsonc"]`（两者都存在时先读 `.json`）。

因此 `dia persona show|default` 的配置解析规则：

| 优先级 | 来源 |
|---|---|
| 1 | `DIA_OPENCODE_CONFIG`（显式路径） |
| 2 | `~/.config/opencode/opencode.json`（存在即用） |
| 3 | `~/.config/opencode/opencode.jsonc`（存在即用） |
| 4 | 都不存在 → 用默认路径 `opencode.json`（`show` 返回「未设置」，`default` 报 `E_CONFIG`） |

两张表都读得懂：读 = JSONC（注释 + 尾逗号）；写 = **只改 `default_agent` 一个键，保留注释与排版**（写回前重新解析校验，坏配置不落盘）。

## 5.3 校验边界：dia 只管自己写的字节（2026-11-01 反思）

**事故**：`dia doctor` 对 dsh profile 目录做整树哈希，而 dsh 首次启动就把 `cordis.yml` 重写成自己的
header 形态（文件头写着 “Edit cordis.patch.yml, not this file”）→ verify 假红，且提示把原因写成
「期望 d07d454c 实得 d07d454c」（内容哈希其实一致，真正 drift 的是宿主目录）。

**结论（越界反思）**：安装器的校验职责边界是 **「自己写入的、宿主不改写的产物」**。

| 对象 | 校验方式 | 理由 |
|---|---|---|
| persona 内容树 / 复制的 agent md / 软链 | 逐字节 sha256 | 只有 dia 会写，改动 = 真篡改 |
| 宿主 profile 目录（dsh） | 存在性 + `.dia-managed` 归属 | 宿主自己会重写 `cordis.yml`、改 `package.json` |
| 默认 agent | 只读、只报告 | dia 契约是「不改默认」，指向别处不算不健康 |

`verify` 现在返回 `issues: string[]`（逐条可读），doctor 直接显示第一条；`remove` 也改为按归属标记判断，
不再因为宿主改写过就拒绝卸载（否则卸载会留残）。


## 6. 当前缺口

1. dabo-agent 没有 `dia.json`、`agents/dabo.md`、dsh persona bundle。
2. dia 没有 `persona` / `kit` 命令。
3. 没有 lock/verify 实现。

## 7. 第一刀

1. dabo-agent 加 `dia.json` + opencode agent + dsh bundle（纯文本，可审）；
2. dia 实现 `persona add/update/remove/verify/list`（先 git + 两宿主）；
3. 临时 HOME E2E：装完 `dabo` 可选中、yan 与默认不变、卸载无残留。
