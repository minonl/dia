# Changelog

本项目未发布版本之间的变更按时间倒序记录（发布历史见 `git log --oneline --grep 'chore(release)'`）。

## Unreleased

### feat(persona): 数据根授权合成（`access`）

- `dia.json` 新增 `access: {read, write, env}`（布尔，缺省 false）与既有的 `data_root` 配对；
  `dia persona add / render` 把它**合成**为 opencode agent frontmatter 的 `permissions` 规则
  （`external_directory` / `read` / `edit` / `.env` 的 ask 兜底），顺序固定、追加在序列尾部。
- 纯函数实现 `src/persona-access.ts`（`composeAgentText`），渲染幂等、按
  `(action, 归一化 resource, effect)` 去重；重装/重渲染按**合成期望**比对，不再误报 `E_CONFLICT`。
- fail closed：畸形 `data_root`（相对路径 / `~user` / 非直挂 / `..` / glob / symlink 逃逸）、
  非布尔 `access` 值、不支持的 frontmatter 结构、以及会被覆盖的更宽 `deny` 一律 `E_MANIFEST`（退出 32）。
- `dia.lock` 增 `access: {declared, added, skipped, root}`；`verify` 校验合成结果与 lock 一致。
- 告警：host 为 `dsh`/`codex` 时 `access` 本期不生效、`write=true` 但 `read!=true`、`data_root` 尚不存在。
- 文档：[`docs/persona-install.md` §5.5](docs/persona-install.md)、`docs/cli.md`；测试：`tests/persona-access-compose.test.ts`。
