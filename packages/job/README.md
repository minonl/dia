# dia-job

> Generic OS scheduler adapter extracted from `yan-task` (launchd / cron / schtasks).
> **Status: M1** — monorepo package `@dia/job` (merged from `minonl/dia-job` via subtree).
> The standalone repo is being archived; use `dia job` or the global install.

## Why a package (not a separate repo)

`yan-task` is an OS integration layer (1075 lines, 4 backends, destructive launchd tests), not a dia framework primitive.
It lives in `packages/job` so `dia` keeps one version/CI while the package boundary stays explicit.
`yan-agent@next` and `dabo` consume the same package; the old standalone repo is archived.

## Contract (v1, compatible with yan-task)

```text
dia-job list|status|doctor|platform
dia-job install <name> --cmd '<shell>' [--interval N|--calendar HH:MM] [--desc D] [--type periodic|bounded|service]
dia-job uninstall <name>
dia-job run|stop|logs <name> [-n N]
dia-job selfcheck [--dry-run]
dia-job bootstrap
dia-job registry
dia-job gc [--days N] [--dry-run]
```

Exit codes: `0/1/2/3/4/5` (same as yan-task).

## Configuration (P2)

| Variable | Default | Meaning |
|---|---|---|
| `DIA_JOB_ROOT` | `YAN_DATA_ROOT` if set, else `~/.local/share/dia-job` | 数据根（旧数据根用全局 config 显式指定） |
| `DIA_JOB_LABEL_PREFIX` | `local.dia-job-` | launchd/cron label 前缀；新部署可用 `local.dia-job-` |
| `DIA_JOB_OWN_TASKS` | 空 | 本仓自有任务名（空格分隔）；不再硬编码 yan 业务任务 |
| `DIA_JOB_NO_LAUNCHD` | 继承 `YAN_TASK_NO_LAUNCHD` / `DIA_JOB_NO_SCHED` | 测试隔离：**不写任何调度条目**（launchd / crontab / systemd） |
| `DIA_JOB_CRONTAB_BIN` | `command -v crontab` | Linux periodic 后端用的 crontab（测试可指向假实现） |
| `DIA_JOB_SYSTEMCTL_BIN` | `command -v systemctl` | Linux service 后端用的 systemctl（测试可指向假实现） |
| `DIA_JOB_CRON_PATH` | `~/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` | 写进 cron 行的 PATH（cron 环境极简，任务常依赖 `~/.local/bin`） |
| `DIA_JOB_EXPECTED` | 空 | 可选 expected 清单；空则跳过 |
| `DIA_JOB_CONFIG` | `~/.config/dia-job/config` | 全局配置文件（纯 KEY=value，不 source） |
| `DIA_JOB_ENTRY_DIR` | `$DIA_JOB_ROOT/bin` | 全局稳定入口目录（ref-entry 判定） |

兼容：`YAN_DATA_ROOT` / `YAN_TASK_NO_LAUNCHD` 仍可用。路径策略在 `lib/policy.sh`，**不依赖 yan-agent / platform.sh**；worktree 用 git `worktree list` 权威判定，不只看命名。

## Install (global, no project dependency)

```sh
bash install.sh              # ~/.local/share/dia-job + ~/.local/bin/dia-job
bash install.sh --dry-run
```

`yan-task` shim: `shim/yan-task` resolves only `DIA_JOB_BIN` / `~/.local/bin/dia-job`; refuses worktree paths.

## Backends (2026-10-30：Linux/WSL 落地)

| 平台 | periodic（`interval`/`calendar`） | service（`--type service`） |
|---|---|---|
| macOS | launchd `~/Library/LaunchAgents/<label>.plist` | 同左（`RunAtLoad` + 无 `StartInterval` 的常驻） |
| **Linux / WSL** | **crontab** 行，带 `# dia-job:<name>` 标记（幂等增删） | **systemd `--user`** unit（`Restart=always` ≈ KeepAlive） |
| Windows native | 未实现（`install` → rc=3，见设计 §4.1） | 未实现 |

Linux 语义对齐要点：

- **无调度**（既无 `--interval` 也无 `--calendar`）→ cron `@reboot`（≈ launchd `RunAtLoad` 的"加载时跑一次"）。
- `--interval` 必须是 **≥60 秒的整分**（cron 最小粒度）；表达不了就 **rc=2 明确拒绝**，绝不"装成看着跑"。
  `--calendar 09:30 --weekdays 1-5` → `30 9 * * 1,2,3,4,5`。
- cron 环境极简 ⇒ 行内显式给 `PATH`；任务体统一走 wrapper（`tasks/<name>.sh`，记 `state.jsonl`）。
- **service 的 linger**：user service 默认随登录会话结束而停 ⇒ 常驻服务需 `loginctl enable-linger <user>`（`doctor` 会提示）。
- `status`：periodic 没有进程状态（cron 是一次性进程）⇒ 显示 `scheduled`/`absent` + `state.jsonl` 上次结论；
  service 显示 `active/failed` + `MainPID`。

## Tests

```sh
bash tests/bootstrap.test.sh   # 16 PASS
bash tests/p2.test.sh          # 6 PASS
bash tests/policy.test.sh      # 7 PASS
bash tests/install.test.sh     # 8 PASS（⚠️ 在 `*-worktree--*` 路径下跑会有 1 例假红：shim 按设计拒绝 worktree）
bash tests/linux.test.sh       # 34 PASS（仅 Linux；假 crontab/systemctl，不碰真实调度器）
```

`YAN_TASK_NO_LAUNCHD=1` is honored by the inherited tests; no launchd writes.

## Migration phases

| Phase | Goal |
|---|---|
| P1 | fork baseline + tests (this repo) |
| P2.1 | parameterize root/label/path; drop yan-specific expected list (done) |
| P3 | adapt tests to `DIA_JOB_ROOT`; CI macOS+Linux |
| P4 | yan-agent@next shim `yan-task` → `dia-job` |
| **P5** | **Linux/WSL 后端落地**（crontab periodic + systemd `--user` service，自愈/在场判定/doctor 同步，2026-10-30） |


## JSON adapter

`lib/json.mjs` is a thin Node adapter for bash (built-in `JSON` only). No Python,
no custom parser. JSONC/JSON5 are not enabled for registry/state files.
