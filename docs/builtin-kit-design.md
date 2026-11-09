# 内置能力的分层：dia-msg 不该让用户「装」

> 日期：2026-11-09 ｜ 状态：**实现中（P0 已合，P1 本文档）** ｜ 触发：用户质疑「dia 是命令入口，为什么内置的还要单独装？dia-msg 都算内置」

## 1. 问题

`dia-msg` 随包发布（`package.json files` 含 `kits/`），但运行时被当成第三方 kit：

- `default-msg.ts` 唯一的动作是 `kit.install(<install>/kits/dia-msg)` → 复制到 `~/.dia/kits/dia-msg/<ver>`、写 `kit.lock`、建 skill 软链
- 复制只在 `persona add/render` 时触发；漏了就 `⚠ missing-kit`，而且 **exit 0**（静默失去消息能力）

用户视角：装完 dia，消息能力「有时有、有时没有」，还要 `dia collab enable` 手动补。

## 2. 三层边界

| 层 | 内容 | 要不要「装」 | 理由 |
|---|---|---|---|
| **用户资产** | persona、第三方 kit | 要（lock / 内容哈希 / remove / 多版本） | 内容来自外部仓库，会漂移，必须能验、能回滚 |
| **内置能力** | dia-msg（未来 git/node kit） | **不要（用户零操作）** | 版本必须跟包走；复制只是「让运行时能读」的实现细节 |
| **宿主可见性** | skill 软链 / agent 入口 / 配置片段 | 首次运行生成，幂等可重建 | 不能随包发布，必须落到各自 HOME |

**结论**：内置能力≠复制一份到数据根，但也不等于直接读包内（pnpm/npx/换 Node 会断链）。折中：

## 3. 拍板方案：懒复制 + 版本戳（B）

- 复制仍发生，但**用户永远不用手装**：任何首次需要它的路径（`persona add/render`、`dia collab enable`）自动完成
- 副本用 **内容哈希**判断是否刷新（版本号常不 bump，只看 semver 会漂移）
- 写自举戳 `~/.dia/state/bootstrap.json`：`{pkg, kit, at}`；`dia doctor` 有 `bootstrap` 检查
  - 无戳 → warn「首次 persona add/render 或 collab enable 会自动装」
  - `stamp.pkg != 当前包版本` → warn「内置能力可能过期；修复：`dia collab enable`」
- `dia collab enable` 装失败 → **exit 32**（不再 exit 0 假成功）

### 为什么不选「内置只读（直接读包内）」

| 阻断 | 后果 |
|---|---|
| `linkManaged` 只认 `~/.dia/kits` / `~/.dia/personas` | 指向包内的软链判 unmanaged → `E_CONFLICT` |
| persona 的 `kits[]` 只允许 persona 树内路径 | 内置 kit 无法被 persona 声明，只能留特例 |
| pnpm `.pnpm/<pkg@ver>/`、npx `_npx/<hash>`、换 Node 前缀 | 包路径会变，软链必然断，需每次升级重链 |

只读模式的收益（少一次复制）不值得新增三条契约；B 保留了 verify/remove/回滚。

## 4. P0：先修安全底座（本 PR 之前已完成）

| 项 | 之前 | 现在 |
|---|---|---|
| `kit.install` 落盘 | `rm -rf target` 后 `cp`，中途失败旧版全没 | staging 目录 + `rename` 原子换入，失败回滚并保留旧版 |
| 并发安装 | 无锁，可能装成「有 lock 但内容残缺」 | 数据根级 `O_EXCL` 锁（`DIA_KIT_LOCK_MS`，默认 5s，陈旧锁 120s 自动清） |
| 版本选择 | 字典序（`0.1.9` > `0.1.10`） | semver 比较，隐藏目录（`.staging`/`.install.lock`）不参与 |
| `installDir()` | 环境变量指向不存在目录也照用 → missing-kit 谜之失败 | 校验存在性，告警并回退探测 |
| `collab enable` | 安装失败仍 exit 0 | exit 32 |

## 5. P2（下一步，未做）

- `install.sh` 文档降级为「开发 / 离线通道」，主推 `npm i -g @minonl/dia`；`install_shadow` 已从 fail 降为 warn
- `dia update` 文案统一成「npm/bun 全局升级」，不再引导 `bash install.sh`
- 若未来出现第二个内置 kit：抽 `builtin kits` 注册表，避免每加一个都改 `default-msg`

## 6. 判据

```bash
bun test tests/kit-atomic.test.ts          # 原子安装 / 锁 / semver / installDir
dia doctor --json | grep -q '"bootstrap"'  # 自举戳可见
dia collab enable; echo $?                 # 装不上 → 32
```
