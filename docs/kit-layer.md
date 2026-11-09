# Kit 层：把「经验」从 persona 里抽出来（设计 v0.1）

> 2026-11-06 用户定调：dws-hub 作为 **channel 层**重构，同时把 git / node 这类**通用工程经验**抽成 **kit 层**，
> 让 yan-agent 更薄、更专业，dabo 等其它 persona 直接复用。本文定 kit 的边界、清单、检索、治理与迁移顺序。

## 0. 三层模型

| 层 | 回答的问题 | 例子 | 归属 |
|---|---|---|---|
| **persona** | 你是谁、怎么干活（身份/语气/工作流编排） | yan、dabo | 各自 persona 仓 |
| **kit** | 你会什么（可复用的经验、工具、知识页） | `kit/git`、`kit/node`、`kit/compose-delivery` | kit 源仓 / registry |
| **channel** | 消息怎么进出 | dws-hub（钉钉 channel+） | dws-hub 仓 |

约束：

- kit **不带人格**、不写人设与语气；只放「换个 agent/换个人也用得上」的内容。
- persona 只保留：身份、规则（must/must-not）、流程编排、**对 kit 的引用**。
- channel 只管传输与协议，不承载业务经验。

## 1. 双标签：一份内容、多领域可检索

同一条经验经常跨领域（本次实例：hook manager 共存 = git × node）。做法：

- kit 清单与知识页 front-matter 都支持 `tags: string[]`；
- 检索按 tag 命中**同一份内容**，不复制两套；
- tag 命名：`git` / `node` / `pnpm` / `hooks` / `worktree` / `channel` / `delivery` …（扁平，不做层级）。

示例：

```json
{ "id": "git", "version": "0.1.0", "tags": ["git", "worktree", "hooks"], "knowledge": ["knowledge/**"] }
```

## 2. 清单（`dia.json`，kind=kit）增量

在现有字段（files / skills / bin / dirs / commands / knowledge / data_root / requires）上新增：

| 字段 | 说明 |
|---|---|
| `tags: string[]` | 检索标签（双/多标签） |
| `provides: string[]` | 提供的知识主题（供 persona 引用与 doctor 校验，如 `git.hooks`） |
| `requires: { "<kit>": "<semver>" }` | 依赖其它 kit（如 `dingtalk` requires `node`） |

## 3. 检索：kb 必须同时搜 persona KB 与已装 kit

现状：`dia kb` 只索引 persona 自带 knowledge。抽 kit 后若不同时索引 kit，会出现「装了解析不到」的假空。

要求：

- `dia kb query --tag git "hook"` → 命中 persona KB + 所有已装 kit 的 knowledge；
- 结果标注来源（`persona:yan` / `kit:git@0.1.0`），便于追踪；
- 0 命中时显式告警（沿用现规则，别当「没有知识」）。

## 4. 治理（doctor）

| 检查 | 级别 |
|---|---|
| kit 已安装且版本满足 persona 的 `requires` | FAIL |
| kit 内容哈希与 lock 一致（drift） | FAIL（可 `dia kit verify` 修复） |
| kit 声明的 bin/skills/files 落点仍在 | FAIL |
| tag 索引与实际知识页 front-matter 一致 | WARN |
| 同一 tag 下存在重复内容（hash 相同） | WARN（提示合并） |

## 5. 迁移进度（2026-11-09）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 设计 + `tags` + `kit list` 展示标签 | ✅ #102 |
| P1 | kit/git、kit/node（worktree / hooks / pnpm） | ✅ #104 #109 #140 |
| P1b | kb 聚合检索（persona KB + 已装 kit，`--tag` 过滤，来源标注，索引过期重建，kit 名额保底） | ✅ #103 #110 #111 |
| P2 | yan-agent 变薄：pnpm 页、worktree 选型/事故复盘迁入 kit；persona 快照同步 | ✅ MR !125 !132 |
| P2b | persona 外部 kit 引用（`id@range`）、安装时自动分发、doctor 版本校验 | ✅ #142 #144 |
| P2c | 槽位排序按 `installedAt`（同 semver 多 commit 不再选错） | ✅ #149 #150 |
| P2d | 版本治理：`dia kit gc`（保最近 N 版 + persona 引用版本） | ✅ #154 #155 |
| P3 | dabo 声明同一套 kit，验证「换 persona 不换经验」 | ✅ dabo-agent #4 |

### 原计划

1. **P0**：本设计 + `dia kit` 支持 `tags`（本 PR）
2. **P1（pilot）**：抽 `kit/git` 与 `kit/node`
   - `kit/git`：worktree 纪律、adopt/doctor/gate、守卫模型、对外无逃生口原则
   - `kit/node`：pnpm 11 `allowBuilds`、lockfile 最小变更、frozen-lockfile、hook manager（husky→simple-git-hooks）
   - 交叉页（hook manager 共存）挂在 `kit/git`，`tags` 双写 `[git, node, hooks]`
3. **P2**：yan-agent 变薄 —— git/node 页面移入 kit，persona 只留身份 + 工作流 + 索引；`install.sh` 改 `dia kit add <src>`
4. **P3**：dabo 装同一套 kit，验证「换 persona 不换经验」；doctor 校验 kit 版本约束

## 6. 非目标

- 不做 kit 市场/评分；kit 来源先支持 git ref 与本地路径。
- 不把 persona 规则（must/must-not）塞进 kit —— 规则仍归 persona，kit 只提供「怎么做」与「踩过什么坑」。
- channel 层不因 kit 化而承担知识分发。
