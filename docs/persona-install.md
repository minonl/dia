# Persona / Kit 安装：用 dia 从 git 地址装

> 日期 2026-10-28，**2026-11-02 复核**（实现状态以 `docs/cli.md §4.1` 为准）。命名已定：**persona = 可被选中的 agent 定义**，**kit = 知识/技能/工具内容**，**profile = 宿主运行环境（dsh）**。
> 安装入口统一为 `dia persona ...` / `dia kit ...`，不再使用 `pkg`。

---

## 1. 命令

```bash
# 取回并注册（私有仓用现有 git 凭据）
dia persona add dabo --from git+https://github.com/minonl/dabo-agent.git --ref <sha>

# 已存在产物与源不一致（用户手改 / 旧版本安装）→ 覆盖；覆盖前备份到 <data>/backups/persona-<id>-<ts>/
dia persona add dabo --from <dir> --force

# 查看 / 校验 / 卸载
dia persona list
dia persona verify dabo
dia persona remove dabo

# 生效版本（多版本并存时指定跑哪一版；有审计）
dia persona show dabo          # 生效版本 + 最近切换记录
dia persona use dabo@0.1.0 --reason "回滚"
dia persona path dabo          # 生效版本目录（服务/脚本取代码用）

# 与上游对比 / 升级（从 lock 记录的 source+ref 重装）
dia persona check dabo         # same/differs/unknown/local-only，exit 0/1/2/3
dia persona update dabo

# 宿主默认 agent（显式动作，不随安装自动做）
dia persona default dabo       # 备份原文件 + 记原值；--unset 精确还原

# 作者轴
dia persona create mybot --dir ~/repos/mybot
dia persona render dabo --host opencode|dsh [--check]

# 内容包
dia kit add --from git+https://github.com/minonl/<kit>.git --ref <sha>
dia kit list / verify <id> / remove <id>

# 作用域（知识根 / 数据根 / 域命令）
dia --persona dabo kb query "…"
dia --persona dabo doctor
```

**渲染目标**：

| 宿主 | 产物 | 是否改默认 |
|---|---|---|
| opencode | `~/.config/opencode/agents/dabo.md` | **否**（用户自己切） |
| dsh | `~/.dsh/profiles/dabo/`（独立 profile；webserver 端口动态，默认回退 1111） | **否**（`dsh --profile dabo`） |
| 记录 | `deps.jsonl` + `dia.lock` | — |

原则：**只新增，不改 yan；默认 agent 必须显式 `persona default` 才动。**

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
  "data_root": "~/.dabo-agent",
  "access": { "read": true, "write": true, "env": false },
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
  → 登记 deps.jsonl（待实现）
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
- `dsh --profile dabo` 启动正常（当时 webserver 3090，避开 3080；2026-11 起 dabo-agent 改为动态端口，默认回退 1111）；
- yan 的 agent/profile 未改动。

> 2026-11-01 补：`dia persona create` / `dia persona render` 已实现（此前只有文档）。
> create 生成骨架时**已内置必填 config**（`tool-fs-search.sampleOverCapGlobResults`），
> render 修产物时先备份到 `<data>/backups/render-<ts>/`；`--check` 只报 drift 不写盘。
> 2026-11-03 补：dsh profile 是宿主领地——宿主会改 `cordis.yml` / `package.json` / 锁文件，
> 这些文件**不参与 drift 比对、re-render 也不覆盖**；render 只写入 persona 自己的产物，
> **不再整树重建 profile**（宿主装的插件目录不会被删）。

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


## 5.4 persona 自带命令与知识根（2026-11-01）

persona 可以在 `dia.json` 里声明（不必单独做一个 kit）：

```json
{
  "knowledge": ["core/knowledge"],
  "data_root": "~/.dabo-agent",
  "commands": [
    { "name": "todo", "entry": "scripts/dabo-task", "runtime": "bash",
      "env": { "DABO_ROOT": "~/.dabo-agent" } }
  ]
}
```

调用与语义：

```bash
dia --persona dabo kb search "台账"   # 知识根 = persona 的 core/knowledge（自动索引到 cache）
dia --persona dabo todo list          # 委派到 scripts/dabo-task；退出码原样透传
```

| 项 | 语义 |
|---|---|
| `knowledge` | 相对 persona 根；`kb` 命令默认用第一个作为根（`DIA_KB_ROOT`） |
| `data_root` | 子进程注入 `DIA_DATA_ROOT_SCOPE` / `DIA_DATA_ROOT`（`YAN_DATA_ROOT` 仅保留给既有 yan 配方） |
| `commands[].runtime` | `bun` / `node`：argv 为 `[entry, <命令名>, ...args]`；`bash`：argv 为 `[entry, ...args]`（**不注入命令名**，脚本自己解析子命令） |
| `commands[].env` | 注入到子进程（值支持 `~` 展开） |
| 命名冲突 | 内置命令优先（`dia task` 是内置，persona 里请用 `todo` 这类不冲突的名字） |
| 隔离 | 命令入口必须在 persona 根内（绝对路径 / `../` 穿越 → `E_DELEGATE_SCOPE`）；若 `env` 写死数据根（如 dabo 的 `DABO_ROOT`），会绕过 `DIA_DATA_DIR` 的测试隔离 |

## 5.5 数据根授权：`access`（dia 合成 permissions，2026-11-24；2026-11-25 改用 yaml round-trip）

> **实现依赖**：合成层用 [`yaml`](https://eemeli.org/yaml/)（`yaml@^2.9.1`，ISC）做
> Document round-trip，不再手写行级解析。dia 因此从「零依赖」变为「依赖 yaml」
> （`bun build` 后约 +233 KB，可接受）。代价换来的是：注释（列 0 / 缩进 / 行尾）、
> 块标量里的 `---`、带引号的键（`"permissions":`）、flow 写法、CRLF 都由解析器原样保留，
> 不会再出现「规则插进 description 块」「重复映射键」这类会让宿主**静默丢弃整个 agent** 的输出。

persona 需要在宿主里读写自己的数据根时，**不要手写 permissions**——在 `dia.json` 里声明，
由 `dia persona add / render` 合成进 opencode agent 文件的 frontmatter。手写的规则会和 dia
的合成结果打架（重装必报 `E_CONFLICT`），也不好审计。

```json
{
  "data_root": "~/.dabo-agent",
  "access": { "read": true, "write": true, "env": false }
}
```

| 字段 | 类型 | 缺省 | 含义 |
|---|---|---|---|
| `data_root` | string | — | 数据根，**必须**形如 `~/.<id>-<后缀>`（直挂家目录一层） |
| `access.read` | boolean | `false` | 允许读 `<root>/**` |
| `access.write` | boolean | `false` | 允许写 `<root>/**`（**false 时显式写 deny**） |
| `access.env` | boolean | `false` | `true` 时**不再加 `.env` ask**：数据根内任意深度的 `*.env` / `*.env.*` 读取全部免确认（含 `romm.env` 这类 token 文件）；`false` 时两条 ask 兜住 |

`read`/`write`/`env` **三者必须都是布尔**；写字符串（如 `"false"`）或数字 → `E_MANIFEST`（退出 32）。

> **`env:true` 的代价必须知情**：`env` 缺省或为 `false` 时，两条 ask 只挂在 `action=read` 上
> （`read <root>/*.env ask`、`read <root>/*.env.* ask`）；`grep` / `shell` 等其它 action **不受这两条约束**
> （它们按宿主各自的默认规则走，别以为 shell 读 `.env` 也会被拦）。设 `env:true` 等于把数据根里
> **所有** `.env`（任意深度，包括保存 token 的 `romm.env`）的**读取**放开，只在确实需要读 token 时才开。

### 5.5.1 合成规则（顺序固定，追加到 `permissions` 序列**尾部**）

| # | 条件 | 规则 |
|---|---|---|
| 1 | 总是 | `external_directory <root>/** allow` |
| 2 | `read=true` | `read <root>/** allow` |
| 3 | `write` | `edit <root>/** allow`（true）/ `edit <root>/** deny`（false） |
| 4 | `read=true` 且 `env!=true` | `read <root>/*.env ask`、`read <root>/*.env.* ask` |

第 4 组必须排在第 2 条**之后**（宿主规则后写生效），否则会被 read allow 吃掉。
`root` 写展开后的**绝对路径**；`env=true` 时**不加第 4 组**（数据根内任意深度 `.env` 读取免确认）。

**`.env` 兜底为什么够**：opencode 的权限 resource 按 glob 匹配，且 `*` **匹配 `/`**（官方文档原文）。
所以 `read <root>/*.env ask` 已经覆盖 `<root>` 下**任意深度子目录**里的 `.env`（`*` 能跨过 `/`），
不需要再补 `**/.env`；`*.env.*` 同理覆盖 `x.env.local` 这类。注意这两条只约束 `action=read`，
`grep` / `shell` 不受控。

### 5.5.2 结构处理（yaml Document round-trip）

- frontmatter 边界：文件首行 `---` 起，到下一条**列 0 且内容为 `---`** 的行结束。
  块标量里的 `---` 有缩进，不会被误当收尾；
- 用 `parseDocument` 解析该段，**有任何 `errors` 直接拒绝**（`E_MANIFEST`，退出 32）——
  不猜、不降级；tab 缩进、重复映射键、括号不配对都由解析器报错；
- 读 `permissions`：`doc.get("permissions")`。`null`/缺键 → `doc.set(...)`；已是列表 → 追加到尾部；
  map 形式（V1 的 `key: effect`）→ 拒绝；
- flow 写法 `permissions: [{action: read, ...}]` 与带注释的 `permissions:` 键行都**合法**（由 yaml 归一）；
- 带引号的键 `"permissions":` 与不带引号的是同一个键（不会再被当成「没有该键」而重复写入）；
- 插在序列最后一项之后，`permissions:` 后面的其它顶层键（如 `browser: deny`）原样保留；
- **字节零变化**：没有规则可追加（全部已存在）时不重新序列化，**原样返回输入**；
- **幂等**：合成只作用于 persona **源 entry**，不作用于已渲染的 dest；重复 render 字节恒等；
- **去重**：已存在同一 `(action, 归一化 resource, effect)` 就跳过。归一化只做三件事：`~`/`~/`、`$HOME`/`$HOME/` 展开；尾部后缀保持原样（`/**` 与 `/*` 是**不同**资源，不做包含推断）。
- **只替换 frontmatter 文本块**：body 逐字节保留（混合换行不会被统一改写）；frontmatter 的换行符按该块自身探测。
- **顺序校验**：等价规则存在但被后面的规则覆盖（后写生效）时拒绝，而不是 `added=0` 静默成功；
  不自动重排（重排会改作者语义），报行号让作者自己调。

### 5.5.3 失败矩阵（全部 fail closed：退出 32、不写盘、不改 lock）

| 情形 | 结果 |
|---|---|
| `access` 存在但 `data_root` 缺失 | `E_MANIFEST` |
| `data_root` 是相对路径 / `~user/x` / `~`（家目录本身）/ `~/repos/x`（不直挂） | `E_MANIFEST` |
| `data_root` 含 `..` 段 或 glob 元字符 `* ? [ ] { }` | `E_MANIFEST` |
| `data_root` 已存在且是 symlink / realpath 逃出家目录 / 不是目录 | `E_MANIFEST` |
| 已有更宽的 `deny`（`action` 为 `*` 或目标 action，resource 覆盖 root 的 glob）会覆盖合成 allow/ask | `E_MANIFEST` |
| 已有同 `(action, resource)` 但 `effect` 不同 | `E_MANIFEST` + **行号**提示 |
| 等价规则已存在（`added=0`），但它后面还有 `*: ask` / 更宽的 allow 会把它覆盖掉 | `E_MANIFEST` + 行号，提示调整顺序（不自动重排） |
| `permissions` 项不是 map、缺 `action`/`resource`/`effect`、字段非字符串或为空、`effect` 不是 `allow|deny|ask` | `E_MANIFEST` + 行号（opencode 会静默丢弃整份 agent） |
| frontmatter 不是合法 YAML（tab 缩进、重复键、括号不配对等） | `E_MANIFEST` |
| V1 map（`permissions:` 下 `key: effect`）、`permissions` 下非映射列表项、无 frontmatter、缺收尾 `---` | `E_MANIFEST` |
| `access.read/write/env` 非 boolean | `E_MANIFEST` |
| `dia.lock` 存在但不是合法 JSON / 顶层为 `null` / 不是对象 | `E_LOCKED`，**退出 32**（`verify`/`render`/`use`/`check`/`update`/`add` 全部不写盘） |
| `verify` / `persona use` 遇到上述 access 错误 | `E_MANIFEST`，**退出 32**（不再降级成 warn 或 exit 1） |

**「更宽 deny」的 glob 判定**（覆盖 root 即拒绝，覆盖 root 的写法包括但不限于）：
`/**`、`/*`、`**/*`、`*`/`**`、`<root>/**`、root 的祖先 glob（`~/*`）、`?` 通配（`~/.<id>-ag?nt/**`）。
判定用前缀/glob 语义（`*` 匹配 `/`、`?` 匹配单字符），不是字符串 `startsWith`。
**花括号不是 glob**：opencode 把 `{ } [ ] ( ) |` 当字面量转义，只有 `*` / `?` 通配，
所以 `{<root>,/tmp}/**` 这种写法**不**被视为覆盖 root（按字面路径处理）。

### 5.5.4 边界与告警

- **本期只对 opencode 生效**：host 为 `dsh` / `codex` 时声明 `access` 只输出一行
  `access 对 host=<x> 本期不生效`（不阻断安装）。dsh 的权限由 profile 插件决定，codex 没有同款 permissions 结构。
  这类 `render --host dsh|codex` **不会改写** lock 里的 `access.added/skipped/root`（保留上一次 opencode 合成的值），
  否则跑一次 dsh 渲染就会把「追加 0 条」永久写进 lock。
- `access.write=true` 但 `read!=true` → 告警（只加写规则，读仍按宿主默认）；
- `data_root` 尚不存在 → 告警（不拒绝：数据根通常由 persona 自己首次运行时创建）。
  **风险**：dia 不负责创建 `data_root`；如果首装时它不存在，之后有别的流程把它建成 **symlink**，
  合成规则就指向了别处。`verify` 会重新校验 `data_root` 形状（symlink / 非目录 / realpath 逃逸 → 退出 32），
  但**首装时**没有任何东西阻止后来的 symlink —— 建议 persona 自己 `mkdir` 创建真实目录，别用软链。
- 合成的字节写进 dest，`dia.lock` 的 `renderedHashes` 与 `access: {declared, added, skipped, root, homedir}`
  都记**合成后**的结果；lock 里已有 `homedir` 时，`render` / `verify` / `update` / `add` **都以它为准**：
  **当前 HOME 与记录不一致时一律拒绝（`E_MANIFEST`，退出 32）**，不会「只 warn 后按旧路径渲染」
  （那会把指向旧家目录的授权写到当前 HOME）。两条出路：① 换回原 HOME；② 显式 `--rehome`
  （`dia persona render <id> --rehome` / `update <id> --rehome` / `add <id> … --rehome`），同时更新 lock 的 `homedir`；
- 计数字段**只有一个口径**（`render --check --json`、真渲染、`install`/`update` 输出与 lock 相同）：
  `added` = **本次合成新增的规则条数**；`skipped` = 源里已有等价规则而跳过的条数；
  `missing` = **dest 相对期望还缺的条数**（只在 `render`/`--check` 报；安装时为 `undefined`）。
  三者互不混用：`added` 不是「还缺几条」；一致时 `missing=0` 而 `added` 仍是合成规则总数。
- 「已存在且不同」的冲突判断也按合成期望比较（否则重装必 `E_CONFLICT`）。

## 6. 当前缺口

1. dabo-agent 没有 `dia.json`、`agents/dabo.md`、dsh persona bundle。
2. dia 没有 `persona` / `kit` 命令。
3. 没有 lock/verify 实现。

## 7. 第一刀

1. dabo-agent 加 `dia.json` + opencode agent + dsh bundle（纯文本，可审）；
2. dia 实现 `persona add/update/remove/verify/list`（先 git + 两宿主）；
3. 临时 HOME E2E：装完 `dabo` 可选中、yan 与默认不变、卸载无残留。
