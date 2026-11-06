---
title: pnpm 11 与构建脚本（allowBuilds）
tags: [node, pnpm, ci]
---

# pnpm 11 要点

## 构建脚本默认被忽略

pnpm 10+ 默认不执行依赖的 `postinstall`。表现：

- 本机：`ERR_PNPM_IGNORED_BUILDS`（退出码 1）
- CI：`Job failed: command terminated with exit code 1`

放行方式（**写在 `pnpm-workspace.yaml`**，pnpm 11 起 `package.json` 的 `pnpm` 字段不再读取）：

```yaml
allowBuilds:
  simple-git-hooks: true
```

旧版本写法是 `onlyBuiltDependencies: ["simple-git-hooks"]`。

## lockfile 只做最小增删

团队仓加/删依赖时，别用新版 pnpm 全量重解析（会重写上万行、把无关依赖升级）：

1. 手工改 `pnpm-lock.yaml`：`importers` 段 + `packages` 段 + `snapshots` 段各一处；
2. 用 `pnpm install --frozen-lockfile`（不带 `--lockfile-only`）验证：通过即说明 lockfile 满足约束，且不会回写。

## 其它

- `pnpm install --frozen-lockfile` 是 CI 的硬门槛，本地也要真装（1~2s 很正常），不要用「借二进制」替代。
- worktree 里安装依赖 = 在**该 worktree** 内安装，不要软链主仓 `node_modules`（见 git kit 的 worktree 页）。
