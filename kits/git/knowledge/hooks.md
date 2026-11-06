---
title: hook 模型与管理器共存（git × node）
tags: [git, node, hooks]
---

# 守卫钩子与 hook 管理器共存

## 三种模式（dia wt adopt 自动判定）

| 仓类型 | 做法 | 效果 |
|---|---|---|
| 普通仓 | 钩子写 `<common>/dia/hooks`，仓库本地 `core.hooksPath` 指过去，并链式调用原钩子目录 | 守卫 + 原钩子都执行 |
| simple-git-hooks 仓 | 不改 `.git/hooks` / `package.json`；守卫写进 `SIMPLE_GIT_HOOKS_RC`，由管理器钩子 source | install 不会覆盖守卫 |
| 其它管理器（husky / `.githooks`） | 不抢占，doctor WARN | 守卫不生效，建议迁移 |

## 为什么不能接管 simple-git-hooks

它只读**仓库本地** `core.hooksPath`：有值就写到那里 → 一旦把 hooksPath 指向 dia 目录，`pnpm install` 就会把守卫文件覆盖掉。
**正确做法是 RC 注入**：钩子模板会 `source "$SIMPLE_GIT_HOOKS_RC"`，守卫在那一步执行。

## RC 自递归（已修复，务必保留标记）

管理器钩子 → source RC → `dia wt guard` → 守卫末尾又链回 `<common>/hooks/<name>`（同一文件）→ 死循环，表现为 `git commit` 卡死。
RC 必须 `export DIA_WT_IN_MANAGER_HOOK=1`，守卫看到标记只判定、不再链式。

## husky → simple-git-hooks 迁移

1. `.husky/*` 内容搬进 `package.json` 的 `simple-git-hooks` 配置；
2. 删 `.husky/` 与 husky 依赖，加 `simple-git-hooks` devDependency + `"postinstall": "simple-git-hooks"`；
3. 清理失效的本地 `core.hooksPath=.husky`，再 `pnpm install` 重建钩子。
