# Changelog

本项目未发布版本之间的变更按时间倒序记录（发布历史见 `git log --oneline --grep 'chore(release)'`）。

## Unreleased

### feat(doctor): 升级自检（钩子模板 / persona access / --core）

- `dia doctor` 新增 `wt.hook`：已 adopt 仓的钩子副本与当前 `dia-wt` 模板版本不一致时 warn（修复：`dia wt adopt . --apply`）。
- `dia wt doctor` 新增 D21：本地钩子缺版本标记/版本过期时 warn；`--fix` 会重写钩子。
- `dia doctor` 新增 `persona.access`：源声明 `access` 但当前安装版本/lock 没合成时 warn（`dia persona update <id>`）；lock 有记录但源已移除时提示重渲染。
- `dia doctor --core`：排除 `job.*` / `collab.*`，只判升级/配置核心面（persona / kit / kb / deps / platform / wt）。

### fix(cli): persona add/render/update 的 --help 补 --rehome

- 跨 HOME 迁移实际支持 `--rehome`，但 help 没列，升级后不可发现。

## 0.2.0 — 2026-11-27

### fix(persona): access 评审第六轮（备份位置 / 产物归属 / 失败可恢复）

- **坏 lock 备份移出 persona 目录**：改到 `<data>/backups/persona-locks/<id>/dia.lock.bak-<slot>-<ts>`，
  不再被当成一个已安装版本（`persona list` 假版本、`active` 指到 `backups`、`gc --keep` 删备份）。
  历史遗留的 `<idDir>/backups/` 由 `versionDirs`/`installedVersions`/`gc`/`remove` 显式排除，`remove` 删槽位时一并清掉。
- **坏 lock 只复制不移动**：备份放在所有前置校验之后、写盘之前；安装失败时原 lock 仍在原位
  （槽位被替换成无 lock 的目录时也会写回），`remove`/重装都保留了依据。
- **`--rehome` 清理旧产物先备份再删**：删除前写到 `<data>/backups/rehome-<id>-<ts>/`；
  内容哈希与 lock 记录不一致（用户手改）时**保留不删**并告警，`renderedRetired` 记为 `{ path, kept: "user-edited" }`。
- **codex `AGENTS.md` 归属校验**：只有「当前字节 == 本 persona 旧 lock 记录的哈希」才删；
  别的 persona 写入的同名文件保留并告警「疑似非本 persona 产物，已保留」。
- **共享产物不被误删**：删除前扫描其它已安装 persona 槽位的 `dia.lock`，该路径仍被别的 persona 引用时
  （同一 codex home + 字节相同的 `AGENTS.md`）保留不删，`renderedRetired` 记 `{ path, kept: "kept-shared", by }`，
  告警「该产物被其它 persona（<id>）引用，已保留」；只对「哈希一致且无人引用」的产物备份后删除。
- **dsh profile 归属检查前移到任何写盘之前**：避免先写 agent md 再失败留下「半安装」。
- **嵌套 `versions/<v>` 下的 `scope.current`** 改用与 `dirOf`/`versionDirs` 同一解析器（嵌套优先），
  `dir`/`kits` 与 `dia persona path` 一致。

### fix(persona): access 评审第四/五轮（恢复路径与边缘场景）

- **`--force` 能从坏 lock 恢复**：`add/update --force` 遇到 `dia.lock` 不可解析时，先把坏文件
  **复制**备份到 `<data>/backups/persona-locks/<id>/dia.lock.bak-<slot>-<ts>` 再继续重装；不加 `--force` 仍退出 32 且字节不变。
  `update --force` 的安装来源由旁路记录 `<data>/state/persona-sources.json` 兜回（lock 才是权威）。
- **`--rehome` 只与 opencode 合成同一次生效**：`render/add --host dsh|codex --rehome` 直接报 `E_USAGE`，
  不再让 lock 出现 `homedir=B / root=A`；非 opencode 渲染沿用 lock 里记录的 `access.homedir`。
- **rehome 清理旧 HOME 残留**：旧 agent md / codex `AGENTS.md` 记入 `lock.renderedRetired` 并从
  `rendered`/`renderedHashes` 移除、文件删除（CLI 打印路径）；`verify` 不再报 missing，`remove` 不再退出 30。
- **`remove` 遇坏 lock 不再半卸载**：删除前先严格解析所有槽位 lock，任一坏 lock 直接 32，一个文件都不动。
- **`add --rehome` 隐含覆盖**已有同 id 产物（无需再叠加 `--force`），`--dry-run --json` 始终输出 JSON
  （含将要清理的旧产物列表）。
- **嵌套 `versions/<v>` 布局**：`install` 的 prevLock 与 `slotDir/dirOf` 同源，存在 `versions/` 时新槽位也写进去，
  `update --rehome` 行为确定（同槽位幂等）。
- **`[` 是字面量**：opencode 只把 `*` / `?` 当通配，`[-]` 不再被当字符类（`<root>/.rc[-]agent/**` 不覆盖 `.rc-agent`）。
- `render --host dsh|codex` 的汇总行显示 lock 里保留的 `added/skipped`（不再打印「追加 0 条」）。

### feat(persona): 数据根授权合成（`access`）

- `dia.json` 新增 `access: {read, write, env}`（布尔，缺省 false）与既有的 `data_root` 配对；
  `dia persona add / render` 把它**合成**为 opencode agent frontmatter 的 `permissions` 规则
  （`external_directory` / `read` / `edit` / `.env` 的 ask 兜底），顺序固定、追加在序列尾部。
- **合成层改用 `yaml`（`yaml@^2.9.1`，ISC）Document round-trip**（`src/persona-access.ts`），
  dia 因此新增第一个运行时依赖。修掉手写行级解析的 3 个 high + 多个中低危缺陷：
  - **high**：更宽 deny 写成 `/**`、`/*`、`**/*`、`?`（opencode 只把 `*` / `?` 当通配，花括号是字面量）时漏检 → 合成的 allow 被静默覆盖；
    现按前缀/glob 语义（`*` 匹配 `/`、`?` 单字符）判定「覆盖 root」并拒绝。
  - **high**：收尾 `---` 对块标量不可靠 → 规则可能插进 description 块（非法 YAML，宿主静默丢弃整个 agent）；
    现只认**列 0** 的 `---`，且整段 `parseDocument` 有 `errors` 直接拒绝。
  - **high**：带引号的 `"permissions":` 被当成没有该键 → 重复映射键（宿主丢弃 agent）；现由解析器归一。
  - 中低危：permissions 块内列 0 注释导致截断、缩进注释被误判非列表项、行尾注释造成假冲突/去重失效、
    flow 单行项与带注释的键行被误拒 —— 全部由 yaml round-trip 解决（注释/块标量/CRLF 原样保留）。
  - `dia persona use` 不再把 `E_MANIFEST` 降级成 warn（exit 32，且切指针前就失败）；
    `verify` 遇 access 错误退出 32（不再 exit 1），并用 lock 记录的 `homedir` 重算（换 HOME 重跑不误报）；
    `persona update` 非 JSON 分支打印 access 告警。
- **计数口径统一**：`added` = 本次合成新增条数、`skipped` = 源里已有等价规则条数、
  `missing` = dest 相对期望还缺几条（只有 `render`/`--check` 报）；lock、`--json`、CLI 文案同一口径。
- **`env:true` 的后果写清**：数据根内任意深度 `*.env` / `*.env.*` 读取免确认（含 `romm.env` 这类 token 文件）；
  `env` 缺省/false 时两条 ask **只挂在 `action=read`** 上，`grep`/`shell` 不受该规则约束。
- **跨 HOME 一律拒绝**：`render`/`verify`/`update`/`add`（含 `--force`、复用槽位）遇到 lock 记录的
  `access.homedir` 与当前 HOME 不一致都退出 32，必须 `--rehome` 才迁移路径（不再「只 warn」）。
- **坏 lock 统一 32**：`verify`/`render`/`use`/`check`/`update`/`add` 的 lock 解析全走 `readLockStrict()`，
  坏 JSON 与顶层 `null` 都报 `E_LOCKED` 退出 32，不再冒 `TypeError` 或降级。
- `render --host dsh|codex` 不改写 lock 的 `access.added/skipped/root`（保留上次 opencode 合成的值），
  只打印「access 对 host=X 本期不生效」；否则跑一次 dsh 渲染会把计数永久归零。
- **花括号不是 glob**：`{ } [ ] ( ) |` 在 opencode 里按字面量转义，只有 `*` / `?` 通配；
  `coversRoot`/`subtreeCovers` 不再做 brace 展开，`{root,/tmp}/**` 视为字面路径（不覆盖 root）。
- 纯函数实现 `src/persona-access.ts`（`composeAgentText`），渲染幂等、按
  `(action, 归一化 resource, effect)` 去重；重装/重渲染按**合成期望**比对，不再误报 `E_CONFLICT`。
  无规则可追加时**原样返回输入**（字节零变化）。
- fail closed：畸形 `data_root`（相对路径 / `~user` / 非直挂 / `..` / glob / symlink 逃逸）、
  非布尔 `access` 值、非法 YAML、V1 map 形式、以及会被覆盖的更宽 `deny` 一律 `E_MANIFEST`（退出 32）。
- `dia.lock` 增 `access: {declared, added, skipped, root, homedir}`；`verify` 校验合成结果与 lock 一致，
  并检测 `data_root` 首装后变成 symlink 的情况。
- 告警：host 为 `dsh`/`codex` 时 `access` 本期不生效、`write=true` 但 `read!=true`、`data_root` 尚不存在。
- 文档：[`docs/persona-install.md` §5.5](docs/persona-install.md)、`docs/cli.md`；测试：`tests/persona-access-compose.test.ts`。

### fix(persona): access 合成第二轮对抗评审修复

- **high** `persona use` 预检与切指针改用同一版本口径（`active.installedVersions` 的 semver+安装时间），
  不再用 `persona.list()` 的字符串排序（`0.9.0` vs `0.10.0` 会分叉）；access 校验失败一律在
  `active.use()` 之前退出 32，`active.json` 不动。
- **high** `pnpm-lock.yaml` 补上 `yaml@2.9.1`；删掉误引入的 `bun.lock` 与 bun 自动加的 `workspaces` 字段
  （仓库以 pnpm 为唯一包管理器，CI 用 `--frozen-lockfile`）。
- **high** `permissions` 项字段校验：必须是 map、`action/resource/effect` 三键齐备且为非空字符串、
  `effect ∈ {allow,deny,ask}`，否则 `E_MANIFEST`（32 + 行号），不再让 opencode 静默丢弃整份 agent。
- **medium** 等价规则已存在但被后续规则覆盖（`*: ask` 排在 allow 之后、`.env ask` 排在 read allow 之前）→
  `E_MANIFEST` 提示作者调顺序，不再 `added=0` 静默失效。
- **medium** `render`/`verify`/`update`/`add` 统一以 lock 记录的 `homedir` 为准；当前 HOME 不一致直接拒绝（32），
  新增 `--rehome` 才改写路径并更新 lock（不再「只 warn」）。
- **medium** 计数口径统一：`added` = 本次合成新增条数、`skipped` = 源里已有条数、
  `missing` = dest 相对期望缺口（只用于展示）；`--check` 与真渲染同口径。
- **medium** 更宽 deny 的 glob 覆盖用例改用 `*` / `?`（花括号在 opencode 是字面量，不展开）；
  补 `coversRoot`/`singleCovers` 对照单测（brace 必须判 false）。
- **low** 只替换 frontmatter 文本块，body 逐字节保留（混合换行不再被统一改写）；frontmatter eol 按块自身探测。
- **low** `persona check` 不再把 `E_MANIFEST` 吞成 `MISMATCH/exit 2`，原样冒泡 32。
