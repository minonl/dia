# AI 工具平台经验库（规则与用法）

> **单一事实源 = [`registry.json`](registry.json)**：平台支持范围、实测版本、已知坑全部只在 JSON 里。
> 本文件**不重复**那些数据，只写规则与用法；人读视图由 `dia doctor` 派生。
>
> 本目录记录的是 **AI 工具平台**（opencode / dsh / codex / pi / mimocode / zed …），不是设备。

---

## 0. 脱敏规则（写之前先看）

| 可以入仓（公开级） | 不入公共仓（私人仓/数据根） |
|---|---|
| 软件名、公开版本号、公开配置键、公开 issue/文档链接 | 内网域名 / IP、账号、凭据、token |
| 通用路径（`~/.config/...`、`~/.dsh/profiles/...`） | 家庭设备、个人设备清单、组织机构内部标识 |
| **公开的 hostname**（公开示例 / demo 环境） | **家庭 / 内网 hostname**、任何能反查到个人或组织的组合信息 |
| 复现命令（用占位符 `<host>` / `<org>` / `<id>`） | 需要脱敏才能写的事实（拿不准就按私人仓处理） |

判据：提交前 `git grep -nE "<内网域名>|<hostname>|<账号>"` 必须为空；拿不准就按"私人仓"处理。

---

## 1. 规则

1. **一条经验 = 版本范围 + 复现命令 + 判据**；没有复现命令的写「未验证」。
2. 数据只改 `registry.json`；不要在 md / README / 知识库里再抄一份（同步必然漂）。
3. `range` 只写简单约束（`>=2.0.0 <3.0.0`）；垫脚石版本先写进 `tested[]`。
4. `supported: false` 的平台只做记录，不参与探测判定。

---

## 2. 怎么改

```bash
# 1) 只改数据源
$EDITOR docs/platforms/registry.json
# 2) 校验 JSON + 单测
bun test tests/platforms.test.ts
# 3) 看派生视图（本机探测 + 范围判定）
dia doctor            # 人读
dia doctor --json     # 机器读
```

新增一个平台：在 `platforms` 下加一项，字段见下；先 `supported: false`，等 `dia persona render --host` 真的支持了再翻 true。

| 字段 | 含义 |
|---|---|
| `supported` | dia 是否已支持渲染到该平台 |
| `render` | 渲染目标路径（未支持时 `null`） |
| `probe` | 探测命令参数（默认 `--version`） |
| `range` | 支持范围（简单约束；`null` = 不判） |
| `tested` | 实测过的版本（用来垫脚，不参与判定） |
| `notes` | 已知坑（一行一条，能复现的写命令） |

---

## 3. 派生视图

`dia doctor` 每次按注册表探测本机平台，输出 `platform:<name>`：

- 装了且在范围内 → `ok`
- 没装 → `warn`（渲染不需要宿主，运行才需要；不判红）
- 版本超出 `range` → `warn`（附支持范围）

安装版从 `~/.local/share/dia/registry/platforms.json` 读（`install.sh` 分发）；开发态回退到仓库 `docs/platforms/registry.json`；
也可用 `DIA_PLATFORMS_FILE` 显式指定。
