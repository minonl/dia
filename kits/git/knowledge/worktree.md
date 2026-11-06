---
title: worktree 纪律（adopt / doctor / gate）
tags: [git, worktree, discipline]
---

# worktree 纪律

## 一次性接管

```bash
dia wt adopt <repo>            # dry-run
dia wt adopt <repo> --apply
dia wt adopt --all --apply     # 仓根下所有主 checkout（跳过 *-worktree--*）
```

- 策略写在 `<git-common-dir>/dia/config.json`（defaultBranch / template / hooksManager）
- 普通仓：钩子写 `<common>/dia/hooks`，仓库本地 `core.hooksPath` 指过去
- simple-git-hooks 仓：走 `SIMPLE_GIT_HOOKS_RC`（见 hooks 页），不改仓内文件
- **不写全局 git 配置**（外溢；D20 会检查残留）

## 巡检与门禁

```bash
dia wt doctor <repo>... [--all] [--fix]
dia wt gate <repo> <feature>     # 提 MR 前：check → doctor → 工作区干净 → ahead>0
```

判据要点：D01 配置 / D02 钩子或 RC 就绪 / D03 守卫探针 / D04 主 checkout 干净 / D05–D07 worktree 卫生 / D11 默认分支 / D20 全局残留 / D21 本地 hooksPath 与模式一致。

## 纪律

- 任何 git 改动先 `dia wt create`；主 checkout 只 `pull --ff-only` / 看代码。
- 守卫没有「跳过」开关：钩子慢就先量化再优化（增量 lint、`nx affected`、缓存、下沉 CI）。
- worktree 内依赖必须**真装**（R20）：跨 checkout 软链 `node_modules` 会让 pnpm 改写主仓链接，删 worktree 后整片悬空。
