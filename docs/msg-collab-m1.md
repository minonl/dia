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
