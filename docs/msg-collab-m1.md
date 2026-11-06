# dia claim：共享热点文件声明（M1a）

> 一句话：在改共享文件前先 `dia claim`，让其它会话看见“谁在改、为什么、什么时候过期”；只告警，不阻断。
> 设计：`docs/msg-collab-m1-design.md` §1

## 什么时候用

- 要改 `install.sh`、`AGENTS.md`、`launchd/`、`docs/index.md` 等**多个会话都可能碰**的文件；
- 交接/并行开发前，先声明路径，避免“改完才发现别人也在改”。

## 命令

```bash
dia claim install.sh --reason "发布拆分" --ttl 4h
dia claims                 # 当前活跃 claim
dia claims --mine          # 只看自己的
dia claims --all           # 含已过期
dia unclaim install.sh     # 释放自己的
```

- claim 只在 `~/.dia/collab/claims.jsonl` 追加事实，**不锁文件、不排队、不阻断编辑**；
- 同一路径多人 claim 时，第二个会看到 `⚠ overlap: <holder>`，退出码仍是 0；
- 默认 4h 过期；`--ttl 30m` / `1d` 可调；
- 只能释放自己的 claim；`--force` 用于清理别人的过期 claim（明确的人工操作）。

## 路径与 scope

- scope 用仓库标识（如 `github.com/minonl/dia`），不写绝对路径；
- `path` 相对仓库根；`../` 越界会报 `E_CLAIM_PATH`；
- 不在 git 仓时用当前目录 basename，scope 为 `local:<dir>`。

## 边界

- 这是 **advisory**：不保证别人真的让路，也不自动改代码/合并；
- 不做全 worktree 锁；文件系统写操作仍以人工/MR 协调为准；
- M1a 不含 `dia in` 提示、pre-commit/MR 强制点（留到后续）。

---

# dia task 依赖 / dia graph（M1b）

## 任务声明

```bash
dia task add "实现 X" --owner ses_... --depends t-a,t-b --touches src/x.ts,docs/x.md --judge "bun test"
dia task link t-xxx --depends t-new --touches src/y.ts
dia task link t-xxx --remove-depends t-old
dia task done t-xxx --evidence "bun test 通过" --reason done
```

- `owner` / `deps` / `touches` 都是可选；旧 task 没有这些字段时自动为 `[]`。
- `done` 仍强制 judge + evidence；`--reason` 只记录 closure_reason，不新增终态。
- `pending`/`blocked` 用 `task status <id> blocked --blocked-reason ...`。

## 依赖图

```bash
dia graph --json
dia graph                 # 人类可读：task → deps + claims
dia graph --json --task t-xxx
```

- 只输出 **declared** 边：`depends_on` / `touches` / `claims`；
- `blocked_by` 只在 task 节点里做派生提示，不是边；
- 任务依赖成环：`cycles` 非空，退出码 **3**（参数错仍是 2）；
- `--task` 只输出该任务的直接依赖/touches/claim 邻居，不做全图闭包。

---

# 只读 TUI 图（M2 第一步）

```bash
dia graph --tui                 # 打印一次（有环 exit 3）
dia graph --watch               # 每 2s 刷新，Ctrl-C 退出
dia graph --tui --no-color      # 关 ANSI 颜色
```

- 按状态分组显示 task → deps / touches / blocked_by；claims 单列；
- 不启 HTTP/daemon，遵守框架“无网络模块”约束；
- `--task t-...` 只显示该任务的直接邻居。

---

# handoff + claim 联动（M2）

```bash
dia claim src/collab.ts --reason "正在重构"
dia out --to ses_xxx --kind handoff --subject "交接" --body-file handoff.md \
        --touches src/collab.ts,docs/msg-collab-m1.md
```

- `--touches a,b`（也接受重复 `--touch`）写入消息 `refs.touches`；
- 发送时如果有他人活跃 claim，输出 `⚠ claim overlap`（advisory，仍发送）；
- 收件方 `dia in` 会在消息下显示 `⚠ claim: <path> 由 <holder> 持有`；
- 不自动排队/阻断；claim 仍是可见性工具。
