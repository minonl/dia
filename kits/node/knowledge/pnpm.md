---
id: tools/pnpm
kind: tool
topic: pnpm 升级与迁移 / node_modules 悬空软链排查
title: pnpm 升级与 runtime 架构（可复用工具知识）
intents: [pnpm, 包管理, pnpm 升级, 悬空软链, dangling symlink, 找不到 Nx 模块, node_modules 损坏, lockfile 漂移, lockfile-only, global virtual store, GVS, 多 worktree, virtualStoreType, enableGlobalVirtualStore]
updated: 2026-11-09
---

# pnpm 升级与 runtime 架构（可复用工具知识）

> 来源：yan-agent `core/knowledge/tools/pnpm.md`（2026-11-09 迁入 kit/node）。

> 跨项目可复用的 pnpm 版本升级坑与 pnpm 12「runtime」发行架构，方案式记录（条件 → 解法）。
> hummus 专属升级上下文见 hummus 仓库 `docs/knowledge/pnpm-12-upgrade.md`；dockerfiles-v2 镜像精确发布姿势见 dockerfiles-v2 仓库 `CLAUDE.md`「精确发布指定镜像」。

## pnpm 12 发行版结构（native binary + wrapper）

pnpm 11 的 npm 包是**直接内置 native binary**（顶层 `pnpm` 文件即 ELF）。pnpm 12 起改为
**wrapper + native binary 拆分**：

- `package.json#bin` 指向顶层 `pnpm`（shebang-less placeholder）
- `install.js`（lifecycle script）把 `@pnpm/exe.<platform>`（如 `@pnpm/exe.linux-x64`）里的
  native binary 链接过来替换 placeholder
- `bin/pnpm.mjs` 是 corepack 入口（corepack 不进 native binary，走 Node 加载）

**坑：升级场景 native binary 不替换**——本机从 pnpm 11 → 12 `npm i -g pnpm@12` 后，顶层 `pnpm`
还是旧的 11.15.1 ELF（install.js 未覆盖旧文件），需手动 `node lib/node_modules/pnpm/install.js`
重链。**全新环境（Docker 镜像 `npm install -g pnpm@latest-12`）无此问题**。

## pnpm 12 是「runtime」，按 packageManager 字段解析版本

pnpm 12 默认开启 `manage-package-manager-versions`（corepack 替代）。binary 是 runtime，
根据**当前目录 package.json 的 `packageManager` 字段**解析实际运行版本：

- `packageManager: pnpm@12.4.2` 的项目 → 用 12.4.2 行为（`pnpm install` 输出 `using pnpm v12.4.2`）
- `packageManager: pnpm@11.15.1` 的项目 → 自动委托 pnpm 11.15.1
- 裸环境（无 packageManager）→ 回退到**本机历史激活版本**（`getpwuid` 读真实 home，绕过 `$HOME`）
  或自身版本

**坑：`pnpm --version` 在裸环境可能显示旧版本号**（如本机有 pnpm 11 状态则显示 11.15.1），
但这是 runtime 回退显示，**不代表实际 install 行为**——实际行为由 packageManager 字段决定。
验证真实版本用「项目目录内 `pnpm install` 的 `using pnpm vX` 输出」，别信裸 `--version`。

## lockfile env 文档头部

`packageManager` 声明 pnpm 12 后，`pnpm install`（非 frozen）会在 `pnpm-lock.yaml` **头部新增
一个 env 文档**（`---` 分隔的第二个 YAML 文档），包含 `packageManagerDependencies` + 锁定
`@pnpm/exe.*` 各平台二进制（12.x）。`--frozen-lockfile` 时 lockfile 若缺此头部会报
`ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`。

**坑：升级必须提交 lockfile env 头部变更**（约 +158 行，全是 pnpm 自身 exe 包，无业务依赖变化）。

## 存量 node_modules 兼容 + store 复用

- lockfileVersion 仍 9.0，pnpm 11 ↔ 12 **锁文件互读兼容**（pnpm 11 读 pnpm 12 的 env 头部文档
  无碍，`Lockfile is up to date, resolution step is skipped`）。
- pnpm 12 直接复用 pnpm 11 的 node_modules 结构（`.modules.yaml` 不重写，`Already up to date`）。
- store 目录沿用平台默认 store（**平台感知**）：Linux/WSL `~/.local/share/pnpm/store/v11`；macOS `~/Library/pnpm/store/v11`
  （CAS 内容寻址，跨版本共享，重装快）。取法：`pnpm store path`（不要硬编码）。

## 多 worktree 支持 = global virtual store（GVS）：现状与启用姿势（2026-10-15 实测）

> 我们大量用 pnpm + 大量 worktree（本机 44 个 checkout）⇒ 「pnpm 官方对多 worktree 的支持是否启用」是个常问项。
> 结论：**项目级全部未启用**；共享方案本身**实测安全且极快**，但属 **experimental + 逐仓决策**，不要全局一刀切。

- **是什么**：默认每个项目的 `node_modules/.pnpm` 各自硬链一份目录结构；开 GVS 后 pnpm 只维护**一份共享虚拟存储**
  `<store-path>/links/`，各项目 `node_modules` 顶层链直接指向它 ⇒ 新增 worktree 安装近乎瞬时、几乎不占磁盘。
- **怎么开**：`pnpm-workspace.yaml` 加 `virtualStoreType: global`（**≥ 11.23.0** 正式拼写；
  更早版本为 `enableGlobalVirtualStore: true`，仍兼容）。**CI 无收益**（冷 store）。
- ⚠️ **死配置陷阱（本机实测）**：写在 `~/.npmrc` 里的 `enableGlobalVirtualStore: true` **不生效**——
  pnpm 12 起 `.npmrc` 只读 auth/registry。判据：中性目录 `pnpm config get enableGlobalVirtualStore` → `undefined`，
  且真装产物仍是本地 `.pnpm`。**要全局开只能写 `~/.config/pnpm/config.yaml`**。
- ⚠️ **`<store>/links/@/` 里有条目 ≠ 项目启用过 GVS**：`pnpm dlx` / `pnpm add -g` **默认走 GVS**
  （本机 128 条 9 月残留即来自此）。
- **本机实测（pnpm 12.5.1，scratch 双 worktree；对照真实仓默认真装 13.8~57.5s / 名义 1.3G）**：

  | 方案 | worktree 装 | worktree `node_modules` | 顶层链指向 | 删 worktree 后对方 |
  |---|---|---|---|---|
  | 默认 | 小包 8ms；真实仓 13.8~57.5s | 436K（真实 1.3G） | `.pnpm/…`（checkout 内） | 不受影响 |
  | `virtualStoreType: global` | **43ms** | **12K** | `<store>/links/@/…`（**共享 store**） | **仍可解析、不悬空** ✅ |

- **与 R20 的关系（判据必须对齐，否则误报）**：GVS 下**顶层链全部"逃出 checkout"**；
  但它指向的是**共享 store**（删 worktree 不连累他人）——与「软链别人的 checkout」（指向短命 checkout）**本质不同**。
  `dia wt check` 已把 `<storeDir>/links` 列入白名单（另有 `virtualStoreDir` 绝对路径的情形）。
- **已知局限**：① 共享可写状态，仅同一信任域；② ESM 提升依赖走 `NODE_PATH`——
  **≥11.23.0** 起 pnpm 自己 spawn 的进程（`run/exec/dlx`、生命周期脚本）带 `NODE_OPTIONS --import` resolve hook 兜底，
  但**在 pnpm 之外直接 `node xxx.mjs` 的脚本拿不到**；③ 官方标注 experimental
  （"some tools may not work correctly with symlinked node_modules"）。
- **启用清单（逐仓）**：升 `packageManager` 到 ≥11.23.0（同步 lockfile env 头部）→ `pnpm-workspace.yaml` 加
  `virtualStoreType: global` → 全量重装 → **lint / typecheck / test / build / serve 全验**（含 `node *.mjs` 类脚本）。
  迁移背景见 `workflows/worktree-forms.md` §3。

### ⛔ 试点结论（2026-10-16，hummus）：**React+TS monorepo 当前不可用**，暂停启用

**一句话**：收益很实在（新 worktree 安装 **2.9s**、`node_modules` **1.9M**），但 GVS 会**打破 TS 类型单例**
⇒ hummus 的 CI 同款 `nx typecheck web-hub` 直接失败。**我们这边不改动任何仓**，等上游或另找方案。

**双 worktree 实测（hummus origin/main，pnpm 11.28.2 + `virtualStoreType: global`）**：

| 维度 | 对照（现状 isolated） | GVS |
|---|---|---|
| 首装（冷 store） | 17.5–20.8s | 36.1s |
| **新 worktree 安装（热 store）** | 17.5–20.8s | **2.9s** ⭐ |
| `node_modules` 体积 | 名义 1.3G | **1.9M** ⭐ |
| `pnpm-lock.yaml` | — | **零变更**（11.x 不需 env 头部；仅 packageManager 一行） |
| nx 项目发现 / lint / test / build / dev | 99 / ✓ / ✓ | 99 / ✓ / 185 用例✓ / business build ✓ / HTTP 200 ✓ |
| `.vite`/`.vitest` 缓存 | 本 worktree | 本 worktree ✓（无跨 worktree 串台） |
| **`nx typecheck web-hub`（CI 同款）** | ✅ 通过 | ❌ **40 条错误** |

**根因（`--traceResolution` 定位）**：GVS 把「每个包的依赖图目录」**实体化**，于是 `@types/react@18.3.1`
在 program 里出现 **6 个不同 realpath 的副本**（对照只有 1 个）；TS 默认按 realpath 归并声明
⇒ 出现"两份 React" ⇒ `not a valid JSX element type` / `TS7006 implicit any`。

**单变量对照（关键，别把锅扣给版本升级）**：同 `pnpm@11.28.2`、仅**关闭** GVS ⇒ typecheck **通过**；
`pnpm@12.11.2` + GVS ⇒ 同样 40 错 ⇒ **上游未修**，是 GVS 本身。

**绕法失败记录（省得重试）**：
- `tsconfig.base.json` `paths` 加 `"@types/react"` 单钉 ⇒ **无效**（TS 的 `@types/*` **自动查找不走 paths**）。
- 把 `react` 映射到 `./node_modules/@types/react` ⇒ **TS 侧 0 错**（类型单例达成），但 hummus 的 vite 配置
  有 **`resolve.tsconfigPaths: true`** ⇒ 同一别名**被用到运行时** ⇒ vitest 4 个文件挂
  （`"." is not exported under the conditions [...] from .../@types/react`）⇒ **不可用**。
  ⇒ 真要救，必须把 pin 放进「**只有 tsc 读到、vite 读不到**」的配置层（typecheck / build-dts 专用 tsconfig），
  需逐项目验证——本轮**不做**（用户 2026-10-16 拍板暂停）。

**复现步骤（约 3 分钟，勿在共享主 checkout 做）**：
```bash
bash `dia wt` create <hummus 主仓> gvs-pilot --base origin/main
cd <worktree> && # package.json: pnpm@11.15.1 → pnpm@11.28.2；pnpm-workspace.yaml 头部加 virtualStoreType: global
pnpm install                                    # 首装冷 store ~36s；再装（热）~3s
pnpm exec nx typecheck web-hub --skip-nx-cache  # ← GVS 下 40 错；关掉 GVS 同版本 pnpm 下 0 错
readlink node_modules/react                     # → <store>/links/@/react/18.3.1/<hash>/...
```

**与本机其他机制的关系**：GVS 与 `dia wt check` 的白名单已对齐（`<storeDir>/links` 不算违规）；
与「禁跨 checkout 软链」（R20）**互补不替代** —— 一个仓若将来启用 GVS，仍应保持 `check` 0 违规。

**何时可重评**：① pnpm 上游自行修掉「GVS 下 `@types` 跨图目录重复」；② 或对**不依赖 TS 类型单例**的仓试点
（纯 JS / 非 React / 无 monorepo 类型共享）。**当前结论：不启用** ——「真装 + 禁软链」的 13.8–57.5s 成本可接受。

> 📌 **不上报上游（2026-10-16 用户决定：没必要性、不需上报任何人）**——本条只当作**将来重评的条件**，
> 后续会话**不要**再提议向 pnpm 提 issue。

## 设置读取变化（pnpm 12）

pnpm 12 起 **`.npmrc` 只读 auth/registry 设置**，其余设置（`hoistPattern`/`nodeLinker`/
`shamefullyHoist` 等）**只从 `pnpm-workspace.yaml` 或全局 `~/.config/pnpm/config.yaml` 读**。
项目若有非 auth 的 `.npmrc` 设置，升级后须迁移到 `pnpm-workspace.yaml`。

## 升级操作清单

1. `package.json` 改 `packageManager: pnpm@<新版本>`
2. `pnpm install`（非 frozen）生成 lockfile env 头部 → 提交
3. 存量验证：`pnpm install --frozen-lockfile` 应 `Already up to date`
4. 全量重装验证：删 node_modules 后 `pnpm install` + typecheck/lint/build
5. CI：镜像（dockerfiles-v2 `pnpm` 镜像）与 packageManager 版本对齐；`pnpm install -g pnpm@latest-N`
   装的是 runtime binary，配合 packageManager 字段自动用对应版本

## node_modules 悬空软链：`nx` / 二进制集体「找不到模块」（2026-10-08 实测，hummus 主仓）

**症状**：仓库内 `nx` / `oxfmt` / pre-push hook 报类如
`Could not find Nx modules at "<repo>"` 或 `Cannot find module '<repo>/node_modules/<pkg>/bin/...'`，
但 `ls node_modules/<pkg>` 明明存在（它是个软链）。

**判定（一条命令）**：软链指向**已不存在的 worktree**——

```bash
find node_modules -maxdepth 1 -type l ! -exec test -e {} \; -print   # 悬空软链清单
readlink node_modules/oxfmt                                          # 看指向（本机实测指向已删的 hummus-worktree--pe-close/node_modules/.pnpm/...）
```

**修法**：仓库根 `pnpm install --frozen-lockfile --prefer-offline` —— 实测 hummus 主仓 21.9s
（94 个悬空链 → 0），只重建链接：**不改** `pnpm-lock.yaml`、工作区仍干净、`oxfmt/oxlint/nx` 全部恢复可执行。

**要点**：

- 本地「lint / format / typecheck 跑不起来」时**先查软链，再怀疑代码**——否则会得出「本地验证通过/不通过」
  的假结论（本机实证：连"删远端分支"这种操作都被 pre-push 拦下——这是钩子在工作，先修环境而不是绕过）。
- 成因未完全定位（软链指向**另一个 worktree** 的 `.pnpm`，疑与该 worktree 安装时共用 virtual store 有关）；
  但检测 + 修复手段通用 → **删掉 worktree 后顺手跑一次悬空检测**，成本 <1 分钟。

## 版本迁移坑与受限环境 EPERM → 已迁出 `tools/pnpm-migration.md`

> 2026-10-26 C13 分页（本页此前 26 KB > 24 KB）：**10→11 迁移坑（musl 二进制 / `minimumReleaseAge` /
> lockfile 同步 / 依赖别名 / `pnpm` 字段失效 / 跨仓升包 / 钉版 EPERM / Alpine libseccomp）** 全部迁至
> **`tools/pnpm-migration.md`**；本页保留 runtime 架构、store/存量兼容、GVS、设置读取、升级操作清单、悬空软链。

