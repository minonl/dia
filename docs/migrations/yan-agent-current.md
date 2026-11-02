# yan-agent 切到 dia：本机现状与剩余迁移

> 2026-11-02。yan-agent 远端 main 已合入 `yan-agent@next`（dia persona 形态）。
> 本文记录本机切换结果和**还没迁完**的部分；事实源仍是本机实际路径。

## 已完成

- yan-agent 本地备份：`~/.yan-agent/backups/yan-agent-<ts>/repo.bundle`
- `dia persona add yan --from ~/.yan-agent/repos/yan-agent` 成功
- `~/.config/opencode/agents/yan.md` 为 dia 渲染版
- `~/.config/opencode/AGENTS.md`、`~/.codex/AGENTS.md` 已切到 dia 版
- `opencode default_agent` 仍为 `yan`
- `dia doctor --persona yan`：`verdict: ok`
- `dia --persona yan kb scene S1/S2`、`query` 实测可用
- 本地兼容 shim（不进仓库）：
  - `yan-kb` → `dia --persona yan kb`
  - `yan-worktree` → `dia wt`
  - `yan-mr` / `yan-release` / `yan-schedule` → `dia --persona yan cmd ...`
  - `yan-task` → `dia-job`

## 还没完成

| # | 缺口 | 影响 | 下一步 |
|---|---|---|---|
| 1 | `dsh` host 未渲染 | `dia.json.hosts` 只有 `opencode`；dsh profile 不生效 | 给 yan 增加 dsh host 或明确只支持 opencode |
| 2 | `yan-env` 仍是旧实现 | 凭据注入仍走旧脚本，未接 `dia env` | 评估 `dia env` 能力后 shim/迁移 |
| 3 | `yan-version` / `yan-ref` 仍是旧实现 | active-ref 迁移未收口 | 按 `active-ref-design.md` 的剩余消费方迁移 |
| 4 | `yan-data-root` / `yan-data-sync` 仍是旧脚本 | 数据根契约未统一 | 评估是否进 dia 或保留域脚本 |
| 5 | 本地 untracked `scripts/yan-kb|yan-task|yan-worktree` | 旧文件仍可能被误用 | 观察一轮后删除，统一走 shim |
| 6 | 仓库 README/rules 仍写旧命令 | 文档与 AGENTS 漂移 | 批量改 `yan-kb`→`dia --persona yan kb`、`yan-worktree`→`dia wt` |
| 7 | launchd 任务未逐条复核 | 任务命令可能仍指向旧 path | `dia job list/status` + `yan-task selfcheck --dry-run` |
| 8 | `dia persona check` 显示 local-only | 未跟踪上游 commit | 需要上游 ref/更新策略 |

## 本机验证命令

```sh
dia persona list
dia persona show yan
dia doctor --persona yan
dia --persona yan kb scene S1
dia --persona yan kb query "评审请求"
dia --persona yan cmd mr --help
dia wt status
dia job list
```

## 原则

- 不再恢复 legacy-yan-cli；已经切到 dia。
- 旧命令只保留稳定 shim，不直接依赖仓库里的 untracked 文件。
- 每次迁移一项，跑上面的验证命令，不一次改完。
