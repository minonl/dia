# dia msg M1：共享热点 claim + 任务依赖 + graph JSON（设计 v0.1）

> 日期：2026-11-05 ｜ 状态：**设计（待实现）** ｜ 上游：`docs/research/msg-collaboration-grill.md`（C1–C3 / D1）
> 原则：** advisory，不阻断**；声明依赖与推断冲突分开；不做 daemon/TUI/全 worktree 锁。

---

## 0. 目标与非目标

| | 内容 |
|---|---|
| **目标** | ① 共享热点文件 `claim`（谁在改、谁让路）；② `dia task` 支持 owner / deps / touches / closure_reason；③ `dia graph --json` 输出任务/claim 依赖图，环检测。 |
| **非目标** | 全 worktree 单写者锁、自动改代码/合并、TUI/Web、跨机同步、daemon。 |
| **成功判据** | 两个会话 claim 同一路径时第二个看到持有者；`dia task` 能回答“谁负责/依赖谁/碰哪些文件”；`dia graph` 能画出依赖并检出环。 |

**为什么先做 claim 而不是全 worktree 锁**：agent 改文件不经过 dia，锁没有执行点；claim 是“可见的承诺 + 开工告警”，比假锁诚实。

### 0.1 开工闸门（planner 2026-11-05）

- M1 **以 M0 真实使用为前提**：两周内执行过 `dia in` 的会话 ≥30%，或至少有 3 个真实会话在用；未达则只定稿设计，不排实现。
- M1 拆两个 MR：**M1a claim**（本文件 §1）/ **M1b task+graph**（§2–§3）；M1a 可先做，M1b 等 M1a 被真实使用。
- M1 不做：`dia in` 联动提示、`dia out --ref path=`、pre-commit/MR 强制点（这些留到 M2 或独立小 MR）。


---

## 1. 共享热点 claim

### 1.1 数据

`~/.dia/collab/claims.jsonl`，append-only；一行一个事件：

```json
{"ts":"...","event":"claim","id":"c-...","path":"install.sh","scope":"repo:/Users/min/repos/github/dia",
 "holder":"ses_...","reason":"发布拆分","expires_at":"...","created_at":"..."}
{"ts":"...","event":"release","id":"c-...","holder":"ses_..."}
```

- `path`：相对 `scope` 的规范化路径（去 `./`、`..` 归一化，不允许越出 scope）；scope 用 **repo slug**（如 `github.com/minonl/dia`）而不是绝对路径，避免把用户名/机器路径写进 JSONL；不在 git 仓时用 cwd basename。
- claim 默认 **4h 过期**（agent 会话通常 <1h；`--ttl` 可改）；过期视为不活跃，但保留历史。
- 同一 `(scope,path)` 允许多个活跃 claim（可见即警告）；不排队、不阻断；`--force` 可接管已过期/失效 holder。
- `release` 必须由 holder 或过期后执行；其他会话不能 unclaim 别人的活跃 claim。
- `claims.jsonl` 用 O_EXCL 锁 append（复用 collab 的 `withLock` 方案）；超过 5000 行时提示 compact。

### 1.2 命令

```bash
dia claim <path> [--reason R] [--ttl 4h] [--force] [--session S] [--json]
dia claims [--all] [--mine] [--json]             # 默认只列活跃
dia unclaim <path|id> [--force] [--session S]
```

- `dia claim` 成功时打印**现有 holder**（包括自己）；有他人持有 → 输出 `⚠ overlap: ...`，退出码 **0**（advisory）。
- 只有 `E_NO_SESSION` / 路径非法 / 参数错才非 0。
- `dia claims` 人类输出：`path  holder  reason  expires`；`--json` 返回数组；`--mine` 只列当前会话。

### 1.3 不在 M1

- `dia in` 末尾追加 claim 提示、`dia out --ref path=`、pre-commit/MR 强制点：全部留到 M2；M1 只做 `claim/claims/unclaim` 命令。

---

## 2. `dia task` 扩展（不新建表）

在现有 `tasks/ledger.jsonl` 上扩展事件与字段，**保持旧数据可读**：

```json
{"event":"add","id":"t-...","title":"...","role":"builder","judge":"...",
 "owner":"ses_...","deps":["t-..."],"touches":["src/collab.ts"],"status":"todo"}
{"event":"link","id":"t-...","deps":["t-..."],"touches":["..."]}
{"event":"status","id":"t-...","status":"blocked","evidence":"...","blocked_reason":"..."}
{"event":"status","id":"t-...","status":"done","evidence":"...","closure_reason":"done"}
```

- `Task` 新增可选：`owner?: string`、`deps: string[]`、`touches: string[]`、`closure_reason?: string`、`blocked_reason?: string`。
- `done` 仍要求 judge+evidence；`closure_reason` 是**元数据**（默认 `done`），不新增终态。
- 终态收敛：`done` = 执行完成；`accepted` = team/human 验收（现有 team 流程）；两者不互相替代，`closure_reason` 只解释 `done/dropped` 的原因。
- 依赖未完成时允许 `doing`，但 `dia graph` 显示 `blocked_by` 派生信息；不自动改状态。
- `dia task list` 人类输出增加 `owner` 与 `deps` 数量；`--json` 全字段；旧任务 `deps/touches` 缺省为 `[]`。

### 2.1 命令

```bash
dia task add "标题" [--owner S] [--depends t-a,t-b] [--touches path1,path2] [--judge J]
dia task link <id> [--depends t-a,t-b] [--touches path1,path2]
dia task status <id> done --evidence E [--reason done|dropped|duplicate|escalated|no-follow-on]
```

---

## 3. `dia graph`（先 JSON，后 UI）

### 3.1 数据契约

```json
{
  "schema": 1,
  "nodes": [
    {"id":"task:t-1","kind":"task","label":"...","status":"doing","owner":"ses_..."},
    {"id":"session:ses_...","kind":"session","label":"..."},
    {"id":"path:src/collab.ts","kind":"path","label":"src/collab.ts"}
  ],
  "edges": [
    {"from":"task:t-2","to":"task:t-1","kind":"depends_on","source":"declared"},
    {"from":"session:ses_...","to":"path:src/collab.ts","kind":"claims","source":"declared"},
    {"from":"task:t-1","to":"path:src/collab.ts","kind":"touches","source":"declared"}
  ],
  "cycles": [["task:t-1","task:t-2"]]
}
```

- 边类型：`depends_on`（declared）、`touches`（declared）、`claims`（declared）；M1 **不把 `blocked_by` 作为边**，只在节点/人类输出里派生显示“被谁挡着”。
- **不把推断冲突画成事实**：M1 只有 declared 边；后续 `inferred` 必须带 `source: inferred` + `confidence`。
- 环检测：任务依赖图有环 → `cycles` 非空，命令退出码 **3**（2 留给参数错；仍输出 JSON）。
- `--task <id>` 只输出该任务的出向 `depends_on` + `touches` + 直接 claim 邻居；不做全图闭包。

### 3.2 命令

```bash
dia graph [--json] [--task t-...] [--session S]
```

- 默认输出全部 task + 活跃 claim + 相关 session/path；人类输出用缩进树（task → deps / touches）。
- `--task` 只输出该任务子图。

---

## 4. 验收

| # | 判据 | 证据 |
|---|---|---|
| V1 | 两个会话 claim 同一路径：第二个看到持有者与 `⚠ overlap`，exit 0；claims.jsonl 有两条 claim | CLI 输出 + JSONL 行数 |
| V2 | `--ttl 1s` 后 sleep，`dia claims` 活跃列表为空；`unclaim` 后立即消失 | 真实验证 |
| V3 | `dia task add --depends/--touches` 落 ledger；旧 task（无新字段）仍可读，deps/touches 为 `[]` | 单测 |
| V4 | `done` 仍强制 judge+evidence；closure_reason 可查，且不改变 accepted 语义 | 单测 |
| V5 | `dia graph --json` 有 task/session/path 节点与 declared 边；两次运行 diff 为空（稳定契约） | JSON fixture 断言 |
| V6 | 依赖环返回 `cycles` 非空 + **exit 3** | 单测 |
| V7 | 无 session 时明确 `E_NO_SESSION`，exit 非 0 | CLI 断言 |
| V8 | claim 并发 append 20 次不丢行、不坏行 | 并发单测 |
| V9 | `dia graph --json` 契约稳定（fixture `tests/fixtures/graph.v1.json`） | 单测 |

---

## 5. 实现拆分

### M1a（claim，可先做）

1. `src/claims.ts`：JSONL 读写 + `withLock` append、路径/scope 规范化、活跃过滤、TTL、`--force`。
2. `packages/cli/src/index.ts`：`claim / claims / unclaim`；help 同步。
3. `tests/claims.test.ts`：V1/V2/V7/V8。

### M1b（task + graph，等 M1a 被真实使用）

4. `src/task.ts`：fold 扩展 + `link` + `closure_reason`；保持旧事件兼容。
5. `src/graph.ts`：从 task/claims 构建节点/边/环；`--task` 子图。
6. `packages/cli/src/index.ts`：`task add/link` 新 flag；`graph`。
7. 测试：`tests/graph.test.ts`、扩展 `tests/task.test.ts`；V3–V6/V9。
8. 文档：`docs/msg-collab-m1.md` 使用说明；两批都要 `node scripts/docs-index.mjs`。

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| claim 被误解为锁 | 文档/输出明确 “advisory，不阻断”；不做自动拒绝 |
| 路径规范化不一致 | 统一 `resolve` + repo root 前缀；拒绝越出 scope |
| 旧 ledger 事件不兼容 | fold 对未知事件忽略；新字段 optional |
| graph 变成“事实” | declared/inferred 分色；M1 只有 declared |
| 使用率低 | `dia claims` 先做“可见”，不做强制门禁 |
