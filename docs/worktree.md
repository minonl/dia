# worktree 纪律（`dia wt`）

> 目标：把「任何 git 改动走 worktree」从**靠人记**变成**脚本可断言**。
> 实现：`packages/wt/bin/dia-wt`（随 npm 包分发，`dia wt` 转发）。

## 1. 一条命令接管仓库

```bash
dia wt adopt <repo>            # 默认 dry-run：打印计划，不落盘
dia wt adopt <repo> --apply    # 写入配置 + 三个守卫钩子
dia wt adopt --all --apply     # 批量：仓根下所有主 checkout（跳过 *-worktree--*）
```

写入内容（幂等，**不改仓内文件、不写全局配置**）：

| 仓类型 | 做法 | 记录 |
|---|---|---|
| 普通仓 | 钩子写 `<git-common-dir>/dia/hooks/`，并把**仓库本地** `core.hooksPath` 指过去（绝对路径） | `hooksManager=local` |
| **simple-git-hooks 仓** | 不碰 `.git/hooks`、不改 `package.json`；守卫写进 `SIMPLE_GIT_HOOKS_RC` 指向的脚本（钩子会 source 它） | `hooksManager=simple-git-hooks` |
| 已有其它 hooksPath（husky / `.githooks`） | **不抢占**，只报告（建议改用 simple-git-hooks） | `hooksManager=external` |

> 判定：`package.json` 里有 `simple-git-hooks`（配置或 devDependency）→ RC 模式；否则看 `core.hooksPath` 是否已被别人占用。

守卫行为：

| 钩子 | 规则 |
|---|---|
| `pre-commit` | 主 checkout 上、分支属于 protected（默认分支 + main/master/develop/dev）→ 拒绝 |
| `pre-push` | 主 checkout 上**任何 push**（含 tag / feature 分支）→ 拒绝；推 `main/master/develop/dev` → 拒绝；并对推送内容做敏感信息扫描 |
| `post-checkout` | 主 checkout 切到非默认分支 → 黄色提示（不阻断） |

pre-push 的敏感扫描按**固定顺序**判定（`packages/wt/bin/dia-wt` `wt_guard_scan`）：

1. 凭证（`BEGIN … PRIVATE KEY` / `AKIA` +16 / `ghp_…` / `github_pat_…`）→ **任何文件**都阻断（文档不豁免）；
2. 敏感目录（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.config/gcloud`、`~/.npmrc`、`~/.pypirc`、`~/.git-credentials`、`~/.env`）→ 一律阻断（`.md` 也不豁免）；
3. 其余**绝对 home 路径**：文档（`.md` / `.markdown` / `.mdx`）只告警，其它文件阻断。

告警与阻断**只写 stderr**（stdout 属于 git 协议，保持空白），最多 5 条 + 「另有 N 条已省略」。
已知缺口（不阻断）：二进制文件（无 `+` 行）、`diff.renames=true` 下的重命名只扫变更行、删分支推送 / root commit 定不出 range 时空 diff 放行。

**钩子链**：本地钩子先跑守卫，再执行 `<common>/hooks/<name>`（simple-git-hooks 等管理器生成处）；`pre-push` 的 stdin 原样转发。
`SIMPLE_GIT_HOOKS_RC` 由 adopt 写入 `~/.zshenv`（带 `# dia-wt:` 标记），脚本内容固定为 `dia wt guard <hook>`。

> ⚠️ husky / `.githooks` 仓：本地 `core.hooksPath` 会覆盖一切，守卫不生效（doctor WARN）。
> 迁移办法：把钩子迁到 simple-git-hooks（`postinstall: simple-git-hooks` + `simple-git-hooks` 配置），再 `dia wt adopt --apply`。

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
| D20 | 全局 `core.hooksPath` 不得指向 dia 旧钩子目录（防外溢；有则 FAIL + 清理命令） |
| D21 | 仓库本地 `core.hooksPath` 与模式一致：local=dia 目录；external=只 WARN |

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

## 6. 没有逃生口：钩子慢就优化

本仓**不提供**跳过钩子的开关，也不在文档/脚本里给绕过示例：

- 钩子执行慢 → **先量**（`time git commit` / `time git push`），定位到具体钩子；
- 优化手段：缓存（如 lint 增量、`nx affected`）、把重活下沉到 CI、减少扫描范围；
- 优化前宁可短暂变慢，也不跳过——一次跳过等于把质量门禁变成装饰。

自动化脚本（release 等）同理：**必须在 worktree 里跑**，不得在主 checkout 上做提交/推送。
