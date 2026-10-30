# dia monorepo：框架模块的归属

> 日期 2026-10-30。结论：**dia-job 回 dia monorepo，作为 `packages/job`；kb 作为 `packages/kb`。**
> 域语义（yan 的 scene/claims、dabo 的个人知识）仍留各自域，不因 monorepo 回流。

---

## 1. 为什么改

- `dia-job` 是框架能力（调度适配器），不是独立产品；独立仓导致：
  - 安装/版本/CI 两套；
  - `dia` 与 `dia-job` 的契约变更不能原子提交；
  - shim 需要跨仓找 binary。
- 但“放回 dia”不等于塞进 `src/`：OS 适配器与核心引擎生命周期不同，必须有**包边界**。
- monorepo 让两者共享版本、测试、发布，同时保留独立包/可选安装。

## 2. 目标结构

```text
dia/
  package.json                 # workspaces: packages/*
  packages/
    core/                      # 现有 src：ingest/audit/freeze/task/persona/team
    kb/                        # 通用 KB：index/query/get/lint/review/path/observe
    job/                       # 调度适配器：launchd/cron/schtasks
      bin/dia-job
      lib/{config,policy}.sh
      tests/
      install.sh
    cli/                       # 可选：dia 命令聚合 core/kb/job
  docs/
```

- 初期可保留 `src/` 作为 core，不急着搬；先加 `packages/job`、`packages/kb`，CLI 用 re-export 兼容旧导入。
- 包管理/工作区：**pnpm workspace**（`pnpm-workspace.yaml`）；运行时/测试/构建仍是 Bun。
- 任务编排：**Turborepo 后置**（M2 后按需）；不在 M0 引入。
- Nx：不选（见 §2.1）。

## 2.1 工具选型

| 工具 | 角色 | 适配 | 结论 |
|---|---|---|---|
| **pnpm workspace** | 包管理器 + workspace 链接/过滤 | 严格依赖边界、`--filter`、lockfile；与 Bun 运行时不冲突 | **选** |
| **Turborepo** | 任务图 + 本地/远程缓存 | 配置轻；当前 3 个包、测试很快，缓存收益低 | **M2 后再加** |
| **Nx** | 全功能 monorepo 平台（生成器/图/插件） | 偏前端/大型全栈；bash 包集成差；引入 daemon/插件体系 | **不选** |
| Bun workspaces | Bun 原生 workspace | 零额外工具；但过滤/发布/版本生态不如 pnpm 成熟 | 备选 |
| npm workspaces | 原生 workspace | 慢，功能少 | 不选 |
| Changesets | 多包版本/发布 | 当前 private、不独立发包 | 需要发布时再加 |

**为什么不是 Bun workspaces**：Bun 负责 `test/build`，但 monorepo 的“包边界/过滤/发布”用 pnpm 更成熟；两者可以共存（pnpm 只做链接与脚本调度，`bun test` / `bun build` 照旧）。
**为什么 Turborepo 后置**：现在 `bun test` 秒级、包少；Turbo 的价值在缓存和 affected tasks，等包数/CI 时长上来再加，避免先背一层 hash/配置。
**为什么 Nx 不选**：我们不是前端大仓，不需要 generator/plugin graph；bash `packages/job` 也不是 Nx 的强项。

## 3. 包边界（硬规则）

1. `core` 不依赖 `job`/`kb` 的具体实现；通过接口/CLI 调用。
2. `job` 不依赖任何域（yan/dabo）路径、知识、任务名；全局配置走 env/`~/.config/dia-job`。
3. `kb` 只做通用知识引擎；**scene/rule/claims/baseline/alerts/record 留域**（见 `docs/migrations/yan-kb.md`）。
4. 域（yan-agent/dabo-agent）只依赖包契约，不反向被包依赖。
5. `job` 的 launchd/cron 写入必须有测试隔离开关；默认 dry-run。

## 4. 迁移阶段

| 阶段 | 动作 | 门禁 |
|---|---|---|
| M0 | ✅ 完成：`pnpm-workspace.yaml` + `packageManager` + `packages/job` 空壳 | `pnpm install` 成功；68 tests / build / smoke / e2e（node+bun）通过 |
| M1 | ✅ 完成：`dia-job` 用 `git subtree` 合入 `packages/job`（保留历史）；根加 `dia job` 路由 | job 4 个测试文件通过；`dia job platform` 可用；独立仓待归档 |
| M2 | `src/kb.ts` 抽到 `packages/kb`，`src/kb.ts` 做 re-export | 现有 kb 测试逐字节通过；查询 golden 不变 |
| M3 | `packages/cli` 聚合；发布/安装脚本统一；评估 Turborepo | 一条 `dia` 安装；job 可选装；CI 仍 <5min 则不加 Turbo |
| M4 | 归档 `minonl/dia-job`，README 指向 monorepo | shim 只指向 monorepo 安装路径 |

## 5. 不做

- 不把 yan 的 scene/claims 搬进 `packages/kb`；
- 不把 dabo 的个人知识搬进 framework；
- 不为“monorepo”引入 nx/turbo；Bun workspaces 足够；
- 不在 M1 同时大改 `src` 目录，避免迁移噪音盖过行为回归。

## 6. 当前决定

- `dia-job` 不再作为长期独立仓；先保留到 M1 完成，随后 archive。
- `yan-kb` 不独立建仓；通用引擎进 `packages/kb`，域语义留 yan-agent@next。
