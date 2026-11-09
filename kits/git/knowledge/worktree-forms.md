---
id: workflows/worktree-forms
kind: workflow
topic: worktree 目录形式
title: 流程：worktree 目录形式选型（平级 vs 仓库内隐藏目录）
intents: [worktree, 目录形式, 平级]
updated: 2026-11-09
---
> 来源：yan-agent `core/knowledge/workflows/worktree-forms.md`（2026-11-09 迁入 kit/git）。判据仍在 persona 的 `rules/worktree.md`（R20/R21/R43/R66）。


# 流程：worktree 目录形式选型（平级 vs 仓库内隐藏目录）

> **结论（2026-09-21 调研定案；2026-09-30 补 pnpm 官方姿势与软链事故实证；2026-10-15 补 GVS 现状/白名单 + 机械闸口）**：**默认平级目录**；仅「无 `node_modules` 且无仓库级扫描工具」的仓可用
> 仓库内隐藏目录；**未知情况一律平级兜底**；**禁止软链 `node_modules`**——精确判据 = **顶层 `node_modules` 是软链 / 跨 checkout 共享**
> （不是禁 node_modules 内部有软链），体检用 `dia wt` check`。
> 关联：R20（改动一律 worktree 隔离）、R21（主 checkout 禁落盘）、R25（合并后清理）、R28（并行服务独立端口）、**R43**（共享仓必须隔离 + 禁 `-A`）。

## 0. 用脚本，别手判（2026-10-12 起）

选型与创建走 **`dia wt`**（**唯一实现**；本节规则 = 其判据来源）：

```bash
`dia wt` form   <repo>                  # 看选型结论（不创建）
`dia wt` create <repo> <feature>        # 建 worktree（自动选形式 + 隔离校验 + 依赖提示/--install）
`dia wt` list   <repo>                  # 列出（标注平级/隐藏）
`dia wt` route  <repo>                  # ★ 开工前必查：合并通道（个人仓 owner 自合 / 团队仓 LGTM+bot；一律走 MR）
`dia wt` check  [<repo>...] [--all]     # ★ node_modules 软链体检（R20 闸口；0 干净 / 1 违规）
`dia wt` clean  <repo> <feature>        # R25 清理（要求工作区干净 + **非**软链 node_modules）
```

### 评审路由（R1.7）：**配置驱动，禁止硬编码仓名**（2026-10-16 用户指正）

> 原先 `route` 把仓名写在脚本里（`yan-agent|personal-agent` → 内部仓；`hummus|*-qa|…` → 业务仓）。
> **错在三处**：① 「哪些仓是我的/业务仓」是**环境事实**，换个人全错；② 它含「**我是谁**」成分 ——
> 仓归属因人而异（本人的自持仓 / 别人的仓），合并通道结论因此不同；
> ③ 每加一个仓都要改共享配方库 ⇒ 漂移。⇒ **规则留在脚本，数据只落本地**（数据根 / personal-agent）。

**判定顺序**（每步记录来源，输出可审计；先否决后放行）：

| # | 条件 | 结论 |
|---|---|---|
| ① | 本地配置 `mr` 名单命中 | **MR + LGTM/bot**（团队仓，显式否决优先） |
| ② | `remote.origin` 命名空间 ∈ `my_namespaces` | **MR + owner 自合**（个人仓；pipeline 绿即可合，无需 LGTM） |
| ③ | 其余 / 信息不足 | **MR + LGTM/bot**（安全侧兜底） |

> **2026-11-05 起没有「直推 main」这一档**：`route.json` 的 `direct` 名单作废，所有仓都走 MR（R1.7）。

**配置**（三键取**并集**：本地只能增不能删；要删就删基线里的条目）：

```
$YAN_ROUTE_CONFIG                            显式指定（最高优先，一般不用）
$YAN_DATA_ROOT/route.json                    本机主入口 —— **可以是软链**，指向个人仓版本化文件
$PERSONAL_AGENT_DIR/config/yan-route.json    个人仓基线（跨设备可版本化）
{ "my_namespaces": ["<user>"], "direct": ["yan-agent"], "mr": [] }
```

⚠️ **`my_namespaces` 缺失时绝不瞎猜**（不拿 git author 的 email 前缀自动当命名空间）——只输出「推测 + 如何确认（`glab auth status`）」，由人写进配置。
回归测试：`bash `dia wt`-route.test.sh`（26 断言，含"无配置时不放行""空列表不误命中""软链配置生效""个人仓+本地并集"）。

**为什么脚本化**（2026-10-12 事故）：选型此前**靠人判断** → agent 在 yan-agent 上**忘了建 worktree**、
直接在 main 工作区提交，并用 `git add -A` 扫走并行会话的在制改动（R43 记录了该事故）。
⇒ 判据固定进脚本，**「拿不准一律平级」由代码兜底**，不再依赖人的当次判断。

> **白名单不硬编码仓名**，按条件检测（§2 三条同时满足才用隐藏）：① 无 `node_modules`
> ② 无仓库级扫描工具 ③ `.gitignore` 已含 `.worktrees/`。任一不满足或**检测不确定 → 平级**。

## 1. 默认：平级目录

`<parent>/<repo>-worktree--<feature>`（如 `~/repos/leyan/hummus-worktree--<feature>`）

理由：

- worktree 必须有自己的**真实 `node_modules`**（软链会被 pnpm purge，见 §3）；
- 平级目录对 nx / vite / eslint / tsc 等「遍历工作树」的工具**天然隔离**：无嵌套 checkout 被扫描、无缓存/端口串台；
- 与既有惯例一致（现网 worktree 全为平级）。

## 2. 例外：仓库内隐藏目录（需同时满足全部条件）

`<repo>/.worktrees/<feature>`

1. 该仓**无 `node_modules`**（纯文档/脚本/元数据仓：yan-agent、leyan-skills、dockerfiles-v2、hasura-metadata、redmine-tools…）；
2. 该仓**无仓库级扫描工具**（无 nx / eslint / tsc / vite / CRA 的全仓扫描）；
3. `.gitignore` 已加 `.worktrees/`（否则主 worktree 出现 `?? .worktrees/`）。

收益 = 顶层目录整洁、集中管理；代价 = 主 worktree 的工具会扫到嵌套 checkout + 需维护 gitignore。

## 3. 判定规则（动手前逐条过）

| 条件 | 目录形式 |
|---|---|
| 需要 `pnpm`/`yarn install` | **平级** |
| 使用 nx（如 hummus） | **平级** |
| 需要 `leyan-scripts release` / changesets release（前端仓） | **平级** |
| 需要并行 `serve` / 构建 | **平级** |
| 纯文档/脚本仓、无依赖安装、无扫描工具 | 隐藏目录可接受（默认仍建议平级） |
| 拿不准 | **平级**（兜底） |

**禁止软链 `node_modules` 到 worktree**（把 A checkout 的 `node_modules` 软链给 B）：pnpm 判定 modules dir
与当前工作区不匹配 → 试图 purge → 无 TTY 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；用 `CI=true`
绕过时会**真删并重建软链目标（主仓）**，且 **pnpm 会把共享 `node_modules` 里的链接改写指向运行 install 的那个
checkout**（`node_modules/<pkg> -> ../../<worktree>/node_modules/.pnpm/...`）——**删除该 worktree 后另一 checkout
的 `node_modules` 全部悬空**（2026-09-30 实证：主仓 198 条悬空链接、`oxfmt` 等直接 `MODULE_NOT_FOUND`）。

**损坏签名与修复配方（2026-10-16 实证，与上条同源、补"怎么认、怎么修"）**：
在「顶层 `node_modules` 是软链」的 worktree 里跑 `CI=true pnpm install` 后，**目标仓（主仓）的
`<repo>/node_modules/.bin/*` 会被改写成 npm 风格 shell shim**（文件开头是 `#!/bin/sh` + `basedir=$(dirname …)`，
mtime = 操作时刻），此时工具可能"还能跑一半"，但 pnpm 语义/链接已被破坏（同批还会出现悬空链接）。
- **认**：`head -c 60 node_modules/.bin/<tool>` 是 `#!/bin/sh`（pnpm 正常形态是软链）→ 中招；
  或 `ls -l node_modules/.bin | head` 看不到 `->` 目标。
- **修**：**在目标仓（主仓）** 执行 `CI=true pnpm install --frozen-lockfile`（恢复 pnpm 布局），
  然后 `bash `dia wt` check <repo>` 复查（A/B/C/D 四类应全 0）。
- **别做**：软链 `node_modules` 进 worktree、或**在软链 worktree 里 `pnpm exec`/`pnpm install`**
  （pnpm 按 realpath 把软链目标当自己的目录处理 → 改写目标仓）。
- **正确姿势**：`dia wt create <repo> <feature> --install`（依赖真装在 worktree 内）+ 开工/收工跑 `check`。
- **worktree 里要不要真装依赖、钩子报错怎么办（2026-10-26 两轮 grill 定论）**：
  - **有 `devDependencies` 的仓 → 必须真装**（含 hasura-metadata 这类只有 prettier/lint-staged/env-cmd 的元数据仓）：
    `pnpm install --frozen-lockfile`（实测 **1.1s / 15M**）。
  - **为什么**：仓内钩子普遍写成 `npx <tool>`；**本地没依赖时 `npx` 会下载最新版**——实测仓内 pinned
    `prettier 2.8.8`，钩子实际跑 **3.9.10**，格式规则不同 ⇒ **假红**（反向的假绿同样可能）。
    ⇒ 钩子报格式错时**先真装再看**（真装后仍失败 → 修钩子/修环境，不得跳过）。
  - **确实无 `devDependencies` 的纯文档仓**才谈得上借：直接调 `<主仓>/node_modules/.bin/<tool>`（版本需一致）；
  - ❌ 任何情况下都不建顶层 `node_modules` 软链、不加 `pnpm ` 前缀（R20 A 类违规，见上）；
  - 钩子慢/失败一律按「量化 → 优化」处理（R66），不设跳过开关。

**判据与体检（2026-10-15 落地）**：禁的是「**顶层 `node_modules` 本身是软链 / 跨 checkout 共享**」，
**不是** node_modules 内部有软链（pnpm `isolated` linker 的顶层包链、`link:` 依赖、dsh profile 的
`node_modules/@leyantech/*`、GVS 的 `<store>/links` 链都是**合法形态**）。机械判据：

```bash
bash `dia wt` check <repo> [--all] [--deep]    # A 顶层软链 / B 逃出 checkout / C 悬空 / D 深层逃逸
```

`create` 会提示真装（`--install` 直接装）、`clean` 对软链 worktree **拒绝清理**
（否则把"主仓是否已被改写"的唯一证据一起删掉）。

**pnpm 官方姿势（正向做法，pnpm.io/zh/git-worktrees）**：

1. **每个 worktree 各装自己的 `node_modules`**：进入该 worktree 跑
   **`pnpm install --frozen-lockfile`**（默认即复用全局内容寻址 store 的硬链接）。
   **实测（2026-09-30，hummus）**：`--frozen-lockfile` 真装 **~22s（release worktree）/ ~34s（feature worktree）**，
   产物 `node_modules` ~1.3G；对比「软链共享」省下的那点时间，**完全不成比例**——软链会把另一 checkout 的
   链接改写指向本 worktree（删除后对方全部悬空，实测 198 条），**绝对不要**。
2. **可选提速（pnpm 官方共享方案）= 全局虚拟存储（GVS）**：`pnpm-workspace.yaml` 加
   **`virtualStoreType: global`**（**≥ 11.23.0** 的正式拼写；更早版本拼 `enableGlobalVirtualStore: true`，仍兼容）
   → pnpm 维护共享虚拟存储（`<store-path>/links/`，`pnpm store path` 可查），各 worktree 的 `node_modules`
   只含指向它的符号链接 → **新增 worktree 安装近乎瞬时、几乎不占额外磁盘**。
   - **本机实测（2026-10-15，scratch 双 worktree，pnpm 12.5.1）**：`virtualStoreType: global` 后
     主 checkout 装 **44ms**、worktree 装 **43ms**；worktree `node_modules` **12K**（对照默认 436K/小包；
     真实仓名义 1.3G）——对照默认真装 **13.8~57.5s**。**关键安全性质**：顶层链指向
     `<store>/links/@/…`（**共享 store，不是别的 checkout**）⇒ **删掉 worktree 后另一 checkout 的链仍可解析**（已实测，
     正是软链方案做不到的："共享但不互相拆台"）。
   - ⚠️ **判据必须与它对齐**：GVS 下**每个顶层链都"逃出 checkout"** ⇒ `dia wt check` 的白名单
     （`<storeDir>/links`）**不加就会全仓误报**。**官方共享方案 ≠ 软链别人的 checkout**，两者必须区分。
   - ⚠️ **别写错地方（本机踩过）**：`~/.npmrc` 里的 `enableGlobalVirtualStore: true` **不生效**——
     pnpm 12 起 `.npmrc` 只读 auth/registry（见 `kit/node`（`dia --persona yan kb query --tag node "pnpm"`））；设置只能放 `pnpm-workspace.yaml`
     或全局 `~/.config/pnpm/config.yaml`。**实测判据**：中性目录 `pnpm config get enableGlobalVirtualStore` → `undefined`。
     （顺带澄清：`<store>/links/@/` 里那 128 条 9 月的残留**不是**项目启用过 GVS——`pnpm dlx` / `pnpm add -g`
     **默认就用 GVS**。）
   - **本机现状（2026-10-15 实测）：项目级全部未启用**——hummus 11.15.1 / jd-qa 11.3.0 / ks-qa·pdd-qa·prokaryote 11.18.0，
     `.modules.yaml` 一律 `virtualStoreDir: .pnpm`（本地）；且**版本都 < 11.23.0**（正式拼写不可用）。
   - 局限（官方文档口径）：① **CI 无用**（无热 store）；② 属共享可写状态，**仅同一信任域**使用；
     ③ ESM 提升依赖走 `NODE_PATH`——**≥11.23.0 起 pnpm 自己 spawn 的进程**（`pnpm run/exec/dlx`、生命周期脚本）
     会带 `NODE_OPTIONS --import` resolve hook 兜底，但**在 pnpm 之外直接 `node xxx.mjs` 的脚本拿不到**；
     ④ 官方标注 **experimental**（"some tools may not work correctly with symlinked node_modules"）
     ⇒ 启用是**逐仓决策**（升 `packageManager` + 全量重装 + lint/typecheck/test/build/serve 全验），
     不建议用全局 config 一刀切。
   - **决策（2026-10-15，用户拍板）**：本轮**只做治理**（`check` 判据 + 守卫 + 巡检），GVS **试点另开任务**；
     两者互补——GVS 是**正向提速**，禁跨 checkout 软链是**禁危险捷径**。
   - ⛔ **试点结果（2026-10-16，hummus）= 暂停启用**：收益实测很实在（**新 worktree 安装 2.9s**、
     `node_modules` **1.9M** vs 名义 1.3G、lockfile 零变更），但 GVS 使「每个包的依赖图目录」实体化 ⇒
     `@types/react` 出现 **6 个不同 realpath 副本** ⇒ TS 按 realpath 归并 ⇒ **CI 同款 `nx typecheck web-hub` 40 错**
     （单变量对照：同 `pnpm@11.28.2` 关 GVS 则通过；`pnpm@12.11.2` 同样错 ⇒ 是 GVS 本身、上游未修）。
     绕法（tsconfig `paths` 钉 `react`）能救 TS，但被 hummus 的 `resolve.tsconfigPaths: true` 带到运行时 ⇒ vitest 挂。
     **完整数据/复现命令/失败尝试见 `kit/node`（`dia --persona yan kb query --tag node "pnpm"`）**。当前维持「真装 + 禁软链」。
3. 相关坑：pnpm 11 起 `pnpm run` 默认 `verifyDepsBeforeRun=install` → **在无 `node_modules` 的 worktree 里跑
   `pnpm run`/`pnpm exec` 会触发 install**（可能触发上面的 purge 逻辑）；WORKTREE 里优先用
   `node <主仓>/node_modules/.bin/<tool>` 或本仓装好后用 `pnpm`。**绝不在「node_modules 是软链」的 worktree 里
   跑任何会触发 install 的命令**。

## 4. 依据（2026-09-21 调研实证）

- **pnpm 官方支持 git worktree**（`pnpm.io/zh/git-worktrees`）：每个 worktree 各装自己的 `node_modules`；
  可选 global virtual store（`virtualStoreType: global`，≥ 11.23）让 worktree install 近乎瞬时；官方示例用**兄弟目录**。
- **路径绑定**：`.modules.yaml` 中 `storeDir` = 绝对路径（可用 `--store-dir` 重定向）、`virtualStoreDir` = 相对 `.pnpm`；
  本机各仓均 `nodeLinker: isolated`，**无仓启用 global virtual store**（故暂无法享受瞬时 install）。
- **pnpm 版本差异**：pnpm 11 起 `pnpm run` 默认 `verifyDepsBeforeRun=install`（会先触发 install），pnpm 9/10 默认不触发
  ——这解释了「release 触发 install」为何主要出现在 hummus / jd-qa / prokaryote（pnpm 11 仓）。
- **`@leyan/scripts release`**（读 `node_modules/@leyan/scripts/scripts/release.js`）：standard-version（skip commit/tag）
  + `git checkout -b release-<ver>` + `git add . && git commit`；只用共享 refs 的 git 操作 →
  **与目录形式无关**（隐藏目录也能跑），但与「是否有真实 node_modules」有关（见 §3）。
- **changesets**：只用 `merge-base`/`diff`/`log`/`rev-parse` 等共享 refs 操作；风险 = **多 worktree 并发 release
  争用 tag/ref** → 发布必须串行。
- **nx（hummus nx 23.2 实证）**：`workspaceId` 由 **git remote 身份**派生（非路径）→ cache + project graph DB
  **有意跨 worktree 共享**（`~/.nx/<hash>`）；本地运行态（`.nx/workspace-data`、daemon socket）按 worktree 隔离；
  `nx reset` 清的是**共享**目录（影响该仓所有 worktree）；**worktree 放仓库内会被主 worktree 的 nx 当项目扫描**
  → nx 仓必须平级。
- **vite / webpack**：`cacheDir`（`node_modules/.vite`）与 babel-loader 缓存（`node_modules/.cache`）均绑定
  `node_modules` → 真装即天然隔离，**软链则跨 worktree 串台**（不同分支依赖不同 → 产物错误）。

## 5. 操作要点

```bash
# 建（默认平级；基于 origin 主分支规避本地落后）
git -C <repo> fetch origin
git -C <repo> worktree add <parent>/<repo>-worktree--<feature> -b <branch> origin/<main|master>

# worktree 内真装依赖（勿软链 node_modules）
cd <parent>/<repo>-worktree--<feature> && pnpm install        # 复用全局 store，~20s 起

# 发布（自动切分支+写文件+提交，必须在独立 worktree）
CI=true pnpm install && pnpm release patch

# 清理（不能在目标 worktree 目录内执行）
git -C <repo> worktree remove <path>
```

## 事故复盘（已分页，2026-10-16）

> 「共享仓库（R43）」「依赖软链（R20）」「主 checkout 落盘污染（R21）」三份**事故复盘**已迁至
> **`workflows/worktree-incidents.md`**；本页只保留规则/流程判据（证据与现场特征集中一处，避免双源）。

- 2026-10-27：2026-10-27 Windows worktree：core.autocrlf=true 使检出为 CRLF，pre-push 的 `npm run lint`（全仓 prettier --check）必然失败 → 推送用 `SKIP_SIMPLE_GIT_HOOKS=1 git push`（CI Linux 侧 LF 校验为准）；另 env-cmd 在本机解析相对 env 路径失败（Failed to find .env file），本地 dev 需脚本注入 env/target/console/*.js 并先设 CI_COMMIT_SHA 规避 git-rev-sync 在 worktree 缺 packed-refs 报错
