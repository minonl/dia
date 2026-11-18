# 缓存治理（`~/.dia/cache`）

> 2026-11-18 定口径。回答三件事：**cache 里是什么**、**什么时候可以删**、**什么不能靠 cache 留**。

---

## 1. 定位：派生数据，不承担保留语义

`~/.dia/cache` 里的东西**全部可重建**：删掉只影响下一次用时的耗时（重新 clone/重建），不影响已经装好的 persona / kit / 配置。

```
~/.dia/cache/
└── src/
    └── <sha1(远程 URL) 前 12 位>/   # git clone 缓存，persona/kit 安装与更新时复用
```

- 条目 = **缓存根下的子目录**；根目录本身永远不是条目，根下散落的文件（`.DS_Store`、`Thumbs.db`、`.lock`）一律忽略。
- `DIA_CACHE_DIR` 覆盖 `src` 根时，`list/gc` 扫的就是覆盖后的目录（与安装/更新的 clone 逻辑一致）。
- 数据根 `~/.dia` 不参与 XDG；`~/.cache/dia/ingest` 是会话采集的游标缓存，另一套，不归本文件管。

**因此：需要长期保留的东西，一律不放 cache。** 要留就备份到 cache 之外——`git bundle`、备份盘、或推进仓库。

## 2. 什么时候可以删

| 条目状态 | `dia cache gc` 默认行为 | 理由 |
|---|---|---|
| 无引用、git 干净、无未推送提交 | **删**（dry-run 只列出来） | 纯可再生，删了下次重 clone |
| 被已安装 persona / kit 引用 | 跳过（`--referenced` 可删） | 删了下次要重新 clone；不是错误，只是慢一点 |
| 有未提交改动 / 有本地独有的提交 | **跳过**，并提示先备份 | 这是 cache 里唯一不可再生的内容 |
| git 状态**无法判定**（仓库损坏、命令超时） | **跳过**（fail-closed） | 宁可少删，不可误删 |

引用判定：`persona` 读 `dia.lock` 的 `source`、`kit` 读 `kit.lock` 的 `source`，按 `sha1(URL)` 前 12 位匹配缓存目录名；
persona 两种目录布局（`<id>/<ver>` 与 `<id>/versions/<ver>`）都认。

## 3. 命令

```bash
dia cache list                       # 条目：体积 / git 状态 / 被谁引用（remote 已脱敏）
dia cache list --root src --json     # 机器读
dia cache gc                         # 默认 dry-run：只说会删什么
dia cache gc --apply                 # 真删（跳过被引用 / 本地独有内容）
dia cache gc --apply --force         # 连本地独有内容也删（删前请自行 git bundle）
dia cache gc --apply --referenced    # 连被引用的缓存也删（下次安装/更新会重 clone）
dia cache gc --apply --root src      # 只清某个根
```

判据（验收用）：

1. `dia cache gc` 不带 `--apply` 时，`du -sh ~/.dia/cache` **不变**。
2. 造一个带未提交改动的缓存条目 → `dia cache gc --apply` 必须跳过它并打印「本地独有内容」。
3. 删掉条目的 `.git/HEAD` 造「状态未知」→ 同样必须跳过。
4. `dia cache list --json` 输出里 **不含** remote 的 userinfo/token（`https://***@host/…`）。
5. 根目录下放一个 `.DS_Store`，`list` 仍按子目录逐条列出（不会把整个根当成一条）。

## 4. 与安装/更新的关系

- persona / kit 的 `--from git+…` 安装与 `dia persona update` 会**复用** `src/<key>`；删了不报错，只是重 clone。
- 缓存键 = `sha1(去掉 git+ 前缀的 URL)` 前 12 位，与 `src/persona.ts`、`src/kit.ts` 的 clone 逻辑同一算法；改算法要三处一起改。
- `kit.lock` / `dia.lock` 都记 `source`（git/URL），这是引用判定的唯一依据；本地目录安装不参与引用保护。
