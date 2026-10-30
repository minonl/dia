# opencode v2 会话分区调查（Project / Location / Workspace）

> 日期 2026-10-28。问题：`opencode ./` 只看到当前目录的会话，是否是专门设计？和 workspace 有什么关系？
> 结论：**是设计，不是 UI 过滤**。Project = 工作目录的身份；Workspace 是另一层（可选、实验性）。

---

## 1. 三层概念

| 层 | 定义 | 行为 | 证据 |
|---|---|---|---|
| **Project** | 工作目录身份：Git 仓跟随 worktree 根；非 Git 目录在 V2 各自成 project（V1 统一 `global`） | 决定 `session list` / TUI picker 的范围 | 官方指南；本机 DB `project_id` |
| **Location** | 每次请求的目录上下文：fs/tools/agents/providers/MCP 都在 `LocationServiceMap` 下 | 同一 server 可服务多个 location | V2 spec |
| **Workspace** | 可选、实验性：session 可绑定 `workspace_id`（worktree） | 本机 34 条 session 全为 NULL | 测试代码 + 本机 DB |

**一句话**：Project 管"看到哪些会话"，Location 管"用哪套文件/工具"，Workspace 管"绑哪个 worktree"。

---

## 2. CLI 行为（实测）

| 命令 | 行为 |
|---|---|
| `opencode ~/proj` | 切到该 project |
| `opencode`（不指定） | 默认 location（server cwd） |
| `opencode session list` | **只列当前 project 的顶层会话**（子会话不出现），默认 100 条，`--format json` 可看 directory/project |
| `--continue` | 只挑"记录目录 = 当前目录"的最新顶层会话 |
| 跨 project | **没有 `--all`**；走 `GET /api/session`（支持 `scope/directory/path/workspaceID/roots`）或直接读 DB |

`cli.json` 的 `session.new_location: inherit` 可让新会话跟随当前活动会话的位置。

---

## 3. 数据模型（本机 opencode.db）

`session` 表关键列：

```
id, project_id, workspace_id, parent_id, directory, path, title,
agent, model, time_created, time_updated, ...
```

- `project_id`：本机分布为 `global`（20）+ 两个具体 project（13/1）；V1 非 Git 目录统一 `global`。
- `workspace_id`：本机全 NULL（实验特性）。
- `directory` / `path`：记录会话发生的位置；`path` 是相对/项目内路径。

---

## 4. 坑

1. **V1 迁移**：V1 非 Git 目录的会话挂在 `global` project，V2 picker 看不到；`GET /api/session` 能取到；修复用 `opencode api post /api/session/<id>/move --data '{"directory":...}'`。
2. **目录改名/删除**：V2 已修（2026-09-02 #23248），但旧会话可能显示 "Session location unavailable"。
3. **不是隔离**：共享 daemon 拥有全部会话；project 只是选择范围。隔离要用 `--standalone` / `--server`。
4. **子会话**：`session list` 不列子会话，采集时要单独取或用 DB。

---

## 5. 对 dia ingest 的影响（已实现）

episode 新增字段：

```yaml
project: string|null        # hash(project_id)，12 位
workspace_id: string|null   # 原样（可能 null）
directory_hash: string      # hash(directory)
path_hash: string           # hash(path)
```

- **默认跨 project 全采**（直接读 DB）；`--project <id>` 只采一个。
- 不依赖 `opencode session list`（会漏 global/跨 project/子会话）。
- 仍不存原始路径，只存哈希；需要回源时用 source + session id。

实测：27 条顶层会话分成 3 个 project；`workspace_id` 全 NULL。

---

## 6. 参考

- opencode v2 CLI Intro（传目录切项目）· 2026-10 · A
- opencode v2 session list 帮助（"current project, newest first"）· 本机实测 · A
- opencode v2 API `POST /api/session`（location）· 2026-10 · A
- opencode v2 session spec（LocationServiceMap、durable inbox）· dev 分支 · A
- 社区指南《Where did my OpenCode session go?》· 2026 · C
- 本机 DB 查询（project_id/workspace_id 分布）· 2026-10-28 · A
