---
title: node 侧 hook 管理器（husky / simple-git-hooks）
tags: [node, git, hooks]
---

# node 项目管理 git 钩子的两种主流方式

| 方案 | 落点 | 特点 |
|---|---|---|
| husky v6+ | `.husky/`（提交进仓），`core.hooksPath=.husky` | 钩子内容进版本库，团队一键生效；但会覆盖任何外部 hooksPath |
| simple-git-hooks | 生成到 `core.hooksPath`（默认 `.git/hooks`） | 配置在 `package.json`，`postinstall` 自动生成；有 `SIMPLE_GIT_HOOKS_RC` 注入点 |

## 统一建议

- 新仓/可改的仓：用 **simple-git-hooks**（配置集中、可被 RC 注入、不占 `.husky`）。
- 已有 husky 的仓：按 git kit 的「husky → simple-git-hooks 迁移」执行；迁移属于提交改动，团队仓走 MR。
- 任何情况下**不要**在主 checkout 用跳过开关绕钩子；钩子慢就优化（增量 lint / 缓存 / 下沉 CI）。
