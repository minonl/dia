# worktree 纪律（`dia wt`）

> 目标：把「任何 git 改动走 worktree」从**靠人记**变成**脚本可断言**。
> 实现：`packages/wt/bin/dia-wt`（`install.sh` 分发到 `<install>/packages/wt`，`dia wt` 转发）。

## 1. 一条命令接管仓库

```bash
dia wt adopt <repo>            # 默认 dry-run：打印计划，不落盘
dia wt adopt <repo> --apply    # 写入配置 + 三个守卫钩子
dia wt adopt --all --apply     # 批量：仓根下所有主 checkout（跳过 *-worktree--*）
```

写入内容（幂等）：

| 项 | 位置 |
|---|---|
| 策略 | `<git-common-dir>/dia/config.json`（`defaultBranch` / `template` / `hooksPath` / `hooksPrevious` / `hooksChain`） |
| 钩子 | `<git-common-dir>/dia/hooks/{pre-commit,pre-push,post-checkout}` |
| `core.hooksPath` | 指向上面目录，**必须是绝对路径**（相对路径在 worktree 会静默失效） |

守卫行为：

| 钩子 | 规则 |
|---|---|
| `pre-commit` | 主 checkout 上、分支属于 protected（默认分支 + main/master/develop/dev）→ 拒绝 |
| `pre-push` | 主 checkout 上**任何 push**（含 tag / feature 分支）→ 拒绝；推 `main/master/develop/dev` → 拒绝 |
| `post-checkout` | 主 checkout 切到非默认分支 → 黄色提示（不阻断） |

**钩子链**：`hooksChain`（首次 adopt 前的 hooksPath，如 `.husky` / `.githooks`）→ `<common>/hooks` → 默认放行。
所以 husky / simple-git-hooks / lefthook 的钩子不会被吞。

> ⚠️ `simple-git-hooks` 的 `postinstall` 会重写 `core.hooksPath` 下的钩子。install 后若守卫被覆盖：
> `dia wt doctor --fix`（或重跑 `dia wt adopt --apply`）。

## 2. 巡检

```bash
dia wt doctor <repo>...     # 单仓/多仓
dia wt doctor --all         # 扫描仓根（<data>/repos、$DIA_WT_REPOS_ROOT，默认 ~/repos）
dia wt doctor --all --fix   # 无损修复：重装三个钩子 + 校正 hooksPath（不删分支/不动 worktree/不提交）
```

判据（FAIL 会让进程 exit 1）：

| ID | 断言 |
|---|---|
| D01 | 已 adopt（`config.json` 存在） |
| D02 | `core.hooksPath` 绝对路径，三个钩子可执行 |
| D03 | 钩子静态包含默认分支（`prot=`），动态探针能拦住主 checkout 的默认分支提交 |
| D04 | 主 checkout 干净且位于默认分支（WARN） |
| D05 | worktree 路径都存在 |
| D06 | 无 prunable / locked |
| D07 | 同一分支不被多个 worktree 占用 |
| D11 | 默认分支可解析（config > origin/HEAD（校验仍存在）> main > master） |

挂成日巡检（mac launchd / linux cron 由 `dia job` 统一）：

```bash
dia job install dia-wt-doctor --calendar 09:00 \
  --cmd "$HOME/.local/bin/dia wt doctor --all --json" \
  --desc "worktree 纪律巡检" --allow-unstable
```

## 3. 提交 MR 前：`gate`

```bash
dia wt gate <repo> <feature>
```

顺序：`check`（依赖体检 R20）→ `doctor` → 目标 worktree 无未提交改动 → `ahead origin/<default> > 0`。
**只做本地门禁，不做 merge / push**——合并仍走 MR + `@bot mergeme`。

## 4. 日常命令

```bash
dia wt create <repo> <feature> [--base main] [--install] [--dry-run]
dia wt list [<repo>]
dia wt status [<repo>] [--stale-days N]
dia wt check [<repo>...] [--all] [--deep]
dia wt clean <repo> <feature|--branch B> [--force] [--keep-branch]
dia wt prune-merged [<repo>] [--all] [--apply]
```

路径模板默认 `{{parent}}/{{repo}}-worktree--{{feature}}`（与历史布局一致，零迁移）；
`adopt --template` 可改（支持 `{{parent}}` `{{repo}}` `{{feature}}` `{{wtRoot}}`），`create/list/clean` 都按它解析。

## 5. 退出码

| 码 | 含义 |
|---|---|
| 0 | 干净 / 成功 |
| 1 | 违规或漂移（doctor FAIL、gate 未通过、check 有违规） |
| 2 | 用法错误（含 `--all` 未匹配到仓库） |
| 3 | 未 adopt |
| 4 | worktree 歧义（多个候选） |

## 6. 逃生口

确需在主 checkout 自动化提交/推送（release 脚本、内部仓直推 main）：

```bash
git commit --no-verify -m "..."
git push --no-verify
```

**必须在 commit / PR 说明里写清原因**；不要为此开白名单（长期例外会钝化守卫）。
