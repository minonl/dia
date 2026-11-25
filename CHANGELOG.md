# Changelog

本项目未发布版本之间的变更按时间倒序记录（发布历史见 `git log --oneline --grep 'chore(release)'`）。

## Unreleased

### feat(persona): 数据根授权合成（`access`）

- `dia.json` 新增 `access: {read, write, env}`（布尔，缺省 false）与既有的 `data_root` 配对；
  `dia persona add / render` 把它**合成**为 opencode agent frontmatter 的 `permissions` 规则
  （`external_directory` / `read` / `edit` / `.env` 的 ask 兜底），顺序固定、追加在序列尾部。
- **合成层改用 `yaml`（`yaml@^2.9.1`，ISC）Document round-trip**（`src/persona-access.ts`），
  dia 因此新增第一个运行时依赖。修掉手写行级解析的 3 个 high + 多个中低危缺陷：
  - **high**：更宽 deny 写成 `/**`、`/*`、`**/*`、`{a,b}/**`、`?` 时漏检 → 合成的 allow 被静默覆盖；
    现按前缀/glob 语义（`*` 匹配 `/`、`?` 单字符、brace 展开）判定「覆盖 root」并拒绝。
  - **high**：收尾 `---` 对块标量不可靠 → 规则可能插进 description 块（非法 YAML，宿主静默丢弃整个 agent）；
    现只认**列 0** 的 `---`，且整段 `parseDocument` 有 `errors` 直接拒绝。
  - **high**：带引号的 `"permissions":` 被当成没有该键 → 重复映射键（宿主丢弃 agent）；现由解析器归一。
  - 中低危：permissions 块内列 0 注释导致截断、缩进注释被误判非列表项、行尾注释造成假冲突/去重失效、
    flow 单行项与带注释的键行被误拒 —— 全部由 yaml round-trip 解决（注释/块标量/CRLF 原样保留）。
  - `dia persona use` 不再把 `E_MANIFEST` 降级成 warn（exit 32，且切指针前就失败）；
    `verify` 遇 access 错误退出 32（不再 exit 1），并用 lock 记录的 `homedir` 重算（换 HOME 重跑不误报）；
    `render --check --json` 的 `access.added/skipped` 取真实值；`persona update` 非 JSON 分支打印 access 告警。
- 纯函数实现 `src/persona-access.ts`（`composeAgentText`），渲染幂等、按
  `(action, 归一化 resource, effect)` 去重；重装/重渲染按**合成期望**比对，不再误报 `E_CONFLICT`。
  无规则可追加时**原样返回输入**（字节零变化）。
- fail closed：畸形 `data_root`（相对路径 / `~user` / 非直挂 / `..` / glob / symlink 逃逸）、
  非布尔 `access` 值、非法 YAML、V1 map 形式、以及会被覆盖的更宽 `deny` 一律 `E_MANIFEST`（退出 32）。
- `dia.lock` 增 `access: {declared, added, skipped, root, homedir}`；`verify` 校验合成结果与 lock 一致，
  并检测 `data_root` 首装后变成 symlink 的情况。
- 告警：host 为 `dsh`/`codex` 时 `access` 本期不生效、`write=true` 但 `read!=true`、`data_root` 尚不存在。
- 文档：[`docs/persona-install.md` §5.5](docs/persona-install.md)、`docs/cli.md`；测试：`tests/persona-access-compose.test.ts`。
