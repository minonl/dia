# HANDOFF — 交接文档（dia / dabo-agent 安装）

> **2026-11-27 复核**：仓库已 **public**；`dia 0.1.8`；`bun test tests` = 1188 pass / 4 skip；`dia job list` = 25 条；
> `dia doctor` 当前 **warn**（`dws-auth-check` / `case-intake` 两个定时任务失败）；npm `0.1.6` 已撤回、`0.1.0–0.1.5` 已 deprecate。
> 以下 2026-11-02 正文保留为历史；冲突以本行为准，现状见 [`docs/overview.md`](docs/overview.md) §3。

> **写于 2026-11-02** ｜ 写者：乐小言（yan） ｜ 按手人：待定
> **读本文的顺序**：先跑 §1 判据 → 不符**以命令输出为准**，先修再看 §2。
> 状态细节的唯一事实源仍是 `docs/status.md`（本文只做**指针 + 交接上下文**，不复制状态表，避免双源漂移）。

---

## 1. 复验判据（不信口头，随时可跑）

在 `~/repos/github/dia` 下：

```bash
git status --short          # 期望：空（工作树干净）
git log --oneline -1        # 期望：当前 main HEAD（不要写死提交号）
bun test tests              # 期望：1188 pass / 4 skip / 0 fail
dia persona list            # 期望：yan 23 个版本 / dabo 7 个 / dia-evoler 1 个
dia persona verify dabo     # 期望：ok <persona 目录>
dia doctor                  # 期望：warn（2 个定时任务失败；persona/kb/deps 应全绿）
```

2026-11-27 实测：上述除 `doctor` 为 warn（`dws-auth-check` / `case-intake`）外全部通过。

> 判据和本文不符 → 先判定「环境漂移」还是「本文过时」，改完再往下。

---

## 2. 现在到哪了

| 项 | 值 |
|---|---|
| 仓库 | `~/repos/github/dia`（**public** `github.com/minonl/dia`），分支 `main`，与 origin 同步 |
| 框架 | D0 ~ D0.16 **全部完成**（kb / ingest / audit / freeze / run / resume / team / monorepo / 全局安装） |
| persona 安装链 | `add / list / verify / render / update / remove / show / use / path / default / check / gc` **已实现**；`create / render` 于 2026-11-01 落地（含 `--host dsh`） |
| dabo 落机 | persona `dabo@0.1.0+gd65941c` 已装；`~/.config/opencode/agents/dabo.md` 已渲染；`~/.dsh/profiles/dabo/`（+ builder/planner/redteam/verifier）已存在 |
| 默认 agent | **仍是 `yan`**（设计原则：dia 只新增，不抢默认） |
| 下一步 | ① Git 历史 7 提交待处理；② 0.1.0–0.1.5 npm tarball 待 support；③ W2 文档真相已补；④ W3–W6 见 `docs/overview.md` §4 |

### 2026-11-01 那一轮的落点（最近 10 个提交，按时间倒序）

```
b7322a6 fix: dsh 模型不再写死        ← 硬编码模型名会挡非目标机型，已改成从配置读
00f062a test: 加固 team 断言
9420a67 test: 假 ACP 跑通 team        ← 不依赖真模型即可回归 team 状态机
d66b2a2 fix: 委派入口限定根内         ← 安全：委派命令不得越出 persona 根
39f6f29 feat: persona 命令支持 bash
f8c0767 feat: persona create/render   ← 本轮主功能
38a3f33 feat: doctor 校验 dsh preset
002c113 fix: verify 不越界校验宿主文件
87fede2 feat: 支持 opencode.jsonc 配置
```

---

## 3. 接手须知（踩过的坑，别再踩）

1. **`dia` 不是 agent**：`dia` 是控制面命令；能聊天的是 `dabo`（个人域）和 `yan`（工作域）。见 `docs/entrypoints.md` §0。
2. **不改 yan、不改默认 agent**：任何"让 dabo 变成默认"的动作都不是安装的一部分，需用户显式要求，且要留 backup + 原值记录。
3. **不越界校验**：`persona verify` 只校验 persona 根内文件（`002c113` 修的），别把宿主文件拉进哈希。
4. **dsh 模型名不许写死**（`b7322a6`）：模型从配置/preset 读，写死会在别的机器上炸。
5. **委派命令限定根内**（`d66b2a2`）：`dia <persona-cmd>` 的路径解析必须落在 persona 目录里。
6. **门禁**：无判据不开工；**无独立验证不合并**；行为改动人批；自签 = 违规（`docs/status.md` §4）。
7. **别在 `main` 工作区直接开发**：用 `dia wt create`（worktree + 依赖真装），收尾 `dia wt clean`。

---

## 4. 待决策（需要用户拍板，不要自行选）

来自 `docs/status.md` §5，原文照抄：

1. D1 先做 doctor 还是 audit 哈希链？
2. D2 的 ModelRunner 以 dsh 为首，是否需要同时接 opencode？
3. D3 的 state 事件是否先只做"深度 + 障碍"两类？
4. D4 的 PR 题源是否只在本地生成、不进任何远程？

---

## 5. 明确不做（防止新会话扩张）

自建沙箱 / 重试 / 压缩（复用 dsh）；公共市场 / 自动安装；多引擎运行时；无证据的团/档位扩张；
未经过独立验证就宣布完成。完整清单见 `docs/status.md` §6。

---

## 6. 已知缺口（不影响主链路，记录在案）

| 缺口 | 影响 | 出处 |
|---|---|---|
| 依赖登记只追加、无 `dia deps record` | 记一条新依赖要手写 JSON 行（保证可移植写法：`command:xxx` / `~/...`，不写死绝对路径） | `docs/dependency-registry.md` |
| **本地目录安装的 persona 无法 `update`** | `update` 拒绝 local 源（`E_SOURCE`）；旧产物与源不同时 `add` 报 `E_CONFLICT`。可用 `dia persona add … --from <dir> --force`（覆盖前备份）刷新，但 `update` 仍未支持本地源 | `src/persona.ts`；`docs/cli.md §4.1` |
| dabo 安装树是旧版本（`dia.json` 无 `knowledge`/`commands`/`data_root`） | 修复前 `--persona dabo kb` 会回落到 cwd 索引；需用 `--force` 重装刷新（2026-11-03 已定位，未执行） | `~/.local/share/dia/personas/dabo/0.1.0/` |
| `persona activation` 模式未实现 | 只能手动 `default`/`use`，无按会话激活 | `docs/persona-install.md` |
| `patches` / `team-automation` / npm 发布 / ACP server | 未开始 | `docs/status.md` §3 |
| 公开 release gate | **BLOCKED until audit**（脱敏 + 历史清洁 + `dia-security` pass） | `docs/security/public-release.md` |

---

## 7. 下一位接手者的最小启动动作

```bash
cd ~/repos/github/dia
sed -n '1,80p'  docs/overview.md    # 三方现状（dia/yan/dabo）+ 已知缺口
sed -n '1,120p' docs/status.md      # 状态表 + 判决 + 待决策
sed -n '1,80p'  docs/persona-install.md   # 安装命令面（本轮改的就是它）
# 选一个 §4 待决策 → 用 dia wt create 开 worktree → 按 D1 判据开工
```
