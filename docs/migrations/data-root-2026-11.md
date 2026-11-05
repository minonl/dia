# 数据根迁移：~/.local/share/dia → ~/.dia（2026-11-05）

> 背景：PR #11 把数据根统一为 `~/.dia`（`DIA_ROOT` 可覆盖，`DIA_DATA_DIR` 兼容一个版本）。
> 代码改了，**安装器和已有数据还要迁**。

## 步骤（一次性）

```bash
# 1) 备份（可选但建议）
mv ~/.local/share/dia ~/.local/share/dia.bak-$(date +%Y%m%d)

# 2) 用新安装器迁（自动 mv 旧根 → ~/.dia 并装新版）
cd ~/repos/github/dia
bun run build
bash install.sh --migrate

# 3) 验证
dia doctor
dia --persona yan kb scene S1
```

## 影响面

| 项 | 变化 |
|---|---|
| persona 安装目录 | `~/.local/share/dia/personas` → `~/.dia/personas` |
| run/审计/审计锚点 | `~/.dia/runs`、`~/.dia/audit` |
| cache | `~/.dia/cache`（kb 索引会重建） |
| msg/agents | `~/.dia/msg`、`~/.dia/agents` |
| dsh profile / opencode agent | 不变（`~/.dsh/profiles`、`~/.config/opencode`） |
| ~/.local/bin/dia 软链 | 指向 `~/.dia/bin/dia.js`（install.sh 自动） |

## 回滚

```bash
rm -rf ~/.dia
mv ~/.local/share/dia.bak-YYYYMMDD ~/.local/share/dia
# 用旧版 dist 重新 install.sh（DIA_HOME=~/.local/share/dia）
```
