---
id: workflows/worktree-incidents
kind: workflow
topic: worktree 事故复盘合集
title: 事故复盘合集：依赖软链（R20）· 共享仓库（R43）· 主 checkout 落盘污染（R21）
updated: 2026-11-09
---
> 来源：yan-agent `core/knowledge/workflows/worktree-incidents.md`（2026-11-09 迁入 kit/git）。判据仍在 persona 的 `rules/worktree.md`（R20/R21/R43/R66）。


# 事故复盘合集（worktree 相关）

> 2026-10-16 自 `workflows/worktree-forms.md` 与 `rules/worktree.md` **逐字搬运**（分页：规则/流程页只留判据，
> **证据、现场特征、复盘**集中在此，避免双源）。⚠️ **本文不是规则** —— 判据请回 `rules/worktree.md`（R20/R21/R43）。

## 依赖软链（R20）· 事故叙述（自 rules/worktree.md 搬出）

    - ⚠️ **已五犯 + 2026-10-15 盘库仍检出在犯**（详见 `workflows/worktree-forms.md`「依赖软链事故复盘」）：
      破坏机制 = 软链**不是只读引用**，pnpm 会按「当前解析到的 store 位置」**重写顶层链**指向本 worktree，
      删 worktree 后对方整片悬空/重装（09-30 主仓 198 条；10-10 一天两次 99/100 条）；
      **连在软链 worktree 里跑 `pnpm nx` / `pnpm exec` 都会触发**（不是只有 `pnpm install`）；
      **现场特征**：主仓 `ls node_modules | wc -l` ≈ 0（顶层链与 `.bin` 整体消失，只剩 `.cache/.pnpm/.vite`）。
      **修复**：受影响 checkout 内 `rm -f node_modules && pnpm install --frozen-lockfile --prefer-offline`（13.8~57.5s，0 悬空）。
      **正确姿势**：worktree 内**真装**；仅为跑已 mock 的 e2e/lint 时用**主仓已装依赖 + `./node_modules/.bin/<tool>` 直调**（别用 `pnpm ` 前缀）。
      ⚠️ **「借二进制」≠「建软链」（2026-10-16 五犯的成因）**：AGENTS.md 说的「借主仓二进制」只指**直接调 `<主仓>/node_modules/.bin/<tool>`**；
      建顶层软链、或加 `pnpm ` 前缀（会触发依赖校验→重装）都属违规。
    - ℹ️ **频次事实（2026-10-15 盘库）**：`check --all` 在四犯后仍扫出 **3 个 worktree 软链主仓**（hummus ×2、prokaryote ×1）
      + 1 处**父级杂散** `~/repos/leyan/node_modules`（跑错 cwd 的 vite/vitest 缓存）⇒「口头纪律」不收敛，
      闸口必须机械化（本轮已落 `check`；父级杂散已清）。
    - **手工复核命令（日常用 `check`，留此备查）**：`find node_modules -maxdepth 1 -type l ! -exec test -e {} \; -print | wc -l`
      （非 0 即已有悬空链）**并同时**跑「指向其他 checkout」检查（两条都过才算干净）。

## 共享仓库事故复盘（R43，2026-10-12）

> 2026-10-16 自 `rules/discipline.md` R43 **逐字搬运**（规则留判据 + 指针；事故经过放这里）。

**事故**：同一天里，yan 在 **主工作区**直接改+提交 dsh-watchdog 一整轮（违反 worktree 原则 ✗），同时
另一个会话也在**直接推 main**、另有一个 teammate 在主工作区留下未提交改动 ⇒ 三者叠在一起 ✗
后果（实测）：① `git add -A` 把 **teammate 的在制工作**扫进 yan 的文档提交 ✗（内容没丢 ✓ 但提交信息与内容不符 ✗）
② 主工作区同时躺着两个会话 + 一个 teammate 的在制改动 ⇒ **谁 `-A` 谁中招** ✗

（同族第二次，2026-10-15：**索引里已躺着他会话 staged 的内容**时，`git commit <我的路径>` 仍会把它们一并提交。
详见 R43「提交前自检」。）

## 依赖软链事故复盘（R20，2026-09-30 ~ 2026-10-15）

> 2026-10-15 自 `rules/worktree.md` R20 **逐字搬运**（规则留判据 + 机械闸口；**证据与现场特征放这里**，
> 同时也让 rules 文件回到体积阈值内）。四犯的原始记录如下：

- ⚠️ **再犯实证（2026-10-10，同一会话连续两次）**：为「跑 lint/e2e」给 worktree 软链主仓 `node_modules`，
  **pnpm/nx 会把主仓的 pnpm 软链批量改写为指向 worktree 路径**（第一次 99 条、第二次 100 条）；
  清理 worktree（`git worktree remove` / `rm -f node_modules`）后这些链接**全部悬空**——主仓依赖崩坏。
  **破坏机制**：软链不是只读引用，pnpm 会按「当前解析到的 store 位置」重写顶层链。
  **修复**：`pnpm install --frozen-lockfile --prefer-offline` 可完全重建（~19s，0 悬空）；git 跟踪文件**不受影响**。
  **正确姿势**：worktree 内**真装**依赖；若仅为跑**已 mock 的 e2e/lint**，优先用
  **主仓已装依赖 + `nx <target>` 指定项目**，或接受在 worktree 真装的一次性成本——**任何情况下都别软链**。
- ⚠️ **三犯实证（2026-10-12，hummus/superbook-auth 修复）**：为跑 `nx test superbook-auth` 又软链了主仓
  `node_modules`（违反 R20）。**本次主仓侥幸未损坏**（悬空 0、被改写 0、主仓 263 测试仍绿）——
  原因只是**跑的 target 已缓存、未触发 pnpm 重写顶层链**，**纯属运气**，不可作「软链安全」的依据。
  **关键教训（识别方法缺口）**：上一条自查命令（数**悬空**链）**只能查出"已经断了"**，
  **查不出「链被改写成指向他人 checkout」**这种更隐蔽、且发生在"断"之前的破坏。**必须补一条**：
  ```bash
  # 主仓根执行：软链是否仍指向自己（不应出现任何 worktree 路径）；期望 0
  find node_modules -maxdepth 1 -type l | while read l; do readlink "$l"; done | grep -c "<worktree 名>"
  ```
  **根治**：别在 worktree 软链。真装实测 **13.8s**（`pnpm install --frozen-lockfile --prefer-offline`）。
  ⇒ 2026-10-15 起这两条手工检查已由 `dia wt check`（A/B/C/D 四类 + GVS 白名单）取代。
- ⚠️ **四犯实证（2026-10-15，hummus 清 lint warning）**：非 `pnpm install` 而是**在软链 worktree 里跑 `pnpm nx <target>` / `pnpm exec`** 就会触发 ——
  pnpm 的「运行前校验依赖」把 worktree 的 `node_modules` 软链 **realpath 成主仓路径**，随后**整仓重装主仓**。
  **现场特征（好识别）**：主仓 `ls node_modules | wc -l` ≈ **0**（顶层包软链 + `.bin` 整体消失，只剩 `.cache/.pnpm/.vite` 等点文件），而 `node_modules/.pnpm` 仍有数千条
  ⇒ 不是"部分损坏"，而是 pnpm 重装的中间态。**修复**：主仓 `pnpm install --frozen-lockfile --prefer-offline`（本次实测 57.5s 全量重链，0 悬空）。
  **要点**：worktree 里**连 `pnpm nx` / `pnpm exec tsc` 都别跑**（不是只有 `pnpm install` 危险）；借主仓依赖时用 `./node_modules/.bin/nx …` 直调，或干脆在 worktree 真装。
- ⚠️ **五犯实证（2026-10-16，hummus `pgfix` worktree）**：把 hummus AGENTS.md「worktree 无 `node_modules` 时**借主仓二进制**（oxfmt）」
  **误推广**成了「建顶层 `node_modules → 主仓` 软链 + 在里面跑 `pnpm exec` / `pnpm nx`」→ 闸口 `dia wt check` 检出 1 处 **A 类**（顶层软链）。
  **正解**：借的是**二进制直调**（`<主仓>/node_modules/.bin/<tool> <file>`），**不得建顶层软链、不得加 `pnpm ` 前缀**（`pnpm ` 前缀会触发依赖校验→重装）。
  **处置**：`rm -f node_modules && pnpm install --frozen-lockfile --prefer-offline`（实测 **20.3s** / 1.3G）→ 闸口 19 checkout **全绿**。
  **本次主仓侥幸未损**（137 条目 / 0 悬空 / 0 跨 checkout 链）—— 只因 worktree 的 `.pnpm` 即主仓 `.pnpm`、相对链同形，**不代表软链安全**。
  **同日全机复核**（`check --all`，45 个 checkout）：除本处外另报 **2 处**（`pdd-qa-worktree--biz-01924`、`prokaryote-worktree--biz-01924`，均软链各自主仓）。
  ⇒ 后续处置（2026-10-16 晚）：两处 worktree 经确认**空闲**（`lsof` 0 引用、工作区干净）后就地**真装**（19.5s / 13.2s）；
  并发现该软链已造成**主仓**（`pdd-qa` / `prokaryote`）**158 条**顶层链被改写成指向 worktree（链 mtime = 那次 install 时刻）
  → 主仓 `rm -rf node_modules` + 真装重建（11.5s / 11.2s）→ 全机复检 **44 checkout 0 违规**。
  **教训**：软链的破坏面是**双向**的（worktree ↔ 主仓），收口时必须**两边都查**（`check <repo>` 会同时报主仓 B 类违规）。
- ℹ️ **盘库（2026-10-15）**：`dia wt check --all`（首跑，全机 44 个 checkout / 3s）报
  **3 个 worktree 软链主仓**（`hummus-worktree--ak-reply-diagnosis-native`、`--staff-sso-order`、`prokaryote-worktree--diagnosis-platform-fix`）
  + **1 处父级杂散** `~/repos/leyan/node_modules`（空 `.vite-temp`/`.vitest` 残留 ⇒ 跑错 cwd 的产物，已清）
  —— 即「四犯」之后**仍在发生**，这是本轮把判据**做成命令**的直接动因。
  **同日处置**：杂散已删；`--staff-sso-order`（**18.7s**）与 `prokaryote--diagnosis-platform-fix`（**17.4s**）
  **就地真装**收口（复验 0 违规）；`--ak-reply-diagnosis-native` **未动** —— 其内 `nx` daemon 常驻
  （`lsof | grep -F <worktree>` 命中 node pid）＝会话在用 ⇒ 按「不碰他人工作」留给属主。
  **操作配方（就地真装）**：
  ```bash
  lsof 2>/dev/null | grep -F "<worktree>"          # ① 判在用：命中即罢了（别动）
  cd <worktree> && rm -f node_modules              # ② 摘链（只删链接，不动对方 checkout）
  pnpm install --frozen-lockfile --prefer-offline  # ③ 真装；**必须带 --frozen-lockfile**（否则可能改写他人分支的 lockfile）
  bash `dia wt` check <repo>           # ④ 复验 0 违规
  ```

## 主 checkout 落盘污染：事故复盘（2026-09-14 ~ 2026-10-12）

> 2026-10-15 自 `rules/worktree.md` R21 下沉（**逐字搬运**）：规则约束与三条机械动作留在 R21，**证据/复盘/事故经过**放这里。

- ⭐ **文档类产出同受约束，且「知道规则」≠「做到」——必须机械化（教训 2026-10-12，第 4 次）**：
  ak 智能体场景本地化迭代把 **spec + 6 份报告 + 4 个知识文档**全写进主 checkout
  （`hummus/docs/...`；**代码零污染**，仅文档越界）。复盘定位**两个独立成因**（有 mtime 硬证据）：
  - **成因 A「文档先于 worktree」**：需求阶段就要出「设计文档 + 行为对比清单」，而 worktree 是**编码阶段**才建的
    → 文档自然落主仓（实测：首份报告 12:28 写出，worktree 15:02 才建，**早 2h34m**）。
    **隐含错误假设：把「worktree 建立」绑死在「编码开始」。**
  - **成因 B「建了 worktree 后仍继续写主仓」**：worktree 已存在，后续 4 份文档**仍写主仓**
    → 动机是**便利性**（主仓路径更短/更眼熟）压过纪律。
  - ⚠️ **该规则自述「2026-09-12 第三次再犯后强化」→ 本次为第 4 次。**
    **结论：「强化文字」这条路已被证明无效**（防过 3 次仍失效）；
    **第 4 次的正确应对不是再写一遍「务必注意」，而是把它变成不依赖记忆的动作**：
    1. **写入前统一预检**（不区分代码/文档）：`git rev-parse --git-dir` ≠ `--git-common-dir`
       且 `git branch --show-current` 非 main —— **文档类写入必须走同一预检**（本次失守点正是「只在写代码时校验」）。
    2. **`docs/**` 写入一律用 worktree 绝对路径**，禁止相对路径从主仓起算
       （直接消掉成因 B 的便利性诱惑）。
    3. **spec/报告产出前移**：需求阶段若需产出文档，**先建 worktree**（可暂不写代码），
       与编码阶段解耦。
  - 附带教训：**同一份文档不要在两个分支同时改** —— 本次把报告更新一并 commit 进主 MR 后，
    另开的 docs MR 因内容已 upstream **变成空 MR**，只能关闭。
  - 可复用收拾清单与完整复盘：`docs/compose/reports/retro-worktree-pollution.md`（hummus）、
    `docs/knowledge/testwin.md`「主 worktree 污染」条目。

- 教训（2026-09-15，`[WSL]`）：hummus「知识库图片上传：key 重复及临时 URL 请求失败」排查会话（agent=yan，会话启动目录 = 主 checkout `/home/<user>/repos/leyan/hummus`）为验证 jsdom 环境是否打印 key 重复警告，用 edit 工具写了临时 `libs/experimental/reply-editor/src/key-dupe.spec.tsx` 后未清理 → 主 worktree 留 untracked 污染。

- 教训（2026-09-14）：testwin-spu-overflow 验证会话对 worktree 的 dev server（localhost:4320）跑了 14 次 playwright-cli（open/snapshot/screenshot）全没 cd，9 个产物落进主 checkout（`.playwright-cli/`，console log 页面路径指向 worktree 而产物在主 checkout）；同功能另一会话每次先 `cd ~/repos/leyan/hummus-worktree--testwin-spu-overflow` 再跑，零污染。

## R56 事故：`git reset origin/main` 当「拉取」⇒ 工作区停旧快照（2026-10-16）

- **事故（2026-10-16，yan-agent）**：另一个 agent 会话用 **`git reset origin/main`（不带 `--hard`）**当"拉取"用 ⇒
  HEAD/索引前进、**工作区留在旧快照** ⇒ 别处新推的文件在它视角里变成 **` D`（索引有、工作区无）**，
  当时含 **27 个刚交付的文件**。若它 `git add -A && git commit`，这些文件会被**从库里删掉**（交付被静默回退）。
