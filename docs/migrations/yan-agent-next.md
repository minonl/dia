# yan-agent@next：迁移到 dia 框架

> 日期 2026-10-29。目标：yan-agent 的“通用能力”沉到 dia，“工作域内容”留在 yan-agent；
> `yan-task` 作为独立私有包/仓维护。本文只定迁移边界与阶段，不搬代码。

---

## 1. 结论（先给判断）

1. **调度器单独建私有仓 `dia-job`**，不塞进 dia 内核：
   - 它不是“知识/审计/任务账本”，而是 **OS 调度适配器**（launchd / cron / schtasks）；
   - 1075 行、4 后端、测试会真实操作 launchd，生命周期与 dia 不同；
   - yan-agent 与 dabo 都要用；放 dia 内核会让“瘦框架”重新变胖。
2. **dia 只吸收“调度契约”**：`dia.json` 声明 jobs，`dia job`/`dia schedule` 调外部 `yan-task` 包；
   dia 不实现 launchd/cron。
3. **yan-agent@next 只留域内容 + shim**：知识、技能、工作域 CLI（`yan-mr` 等）和安装入口；
   通用实现一律委托 dia 或独立包。
4. **先做 phase 1（抽取 yan-task）**，通过双跑与契约测试后再动 yan-kb/yan-worktree。

---

## 2. 现状盘点（2026-10-29）

| 脚本 | 行数 | 性质 | 归属判断 |
|---|---:|---|---|
| `scripts/yan-task` | 1075 | OS 调度 + 任务登记 + 自愈 | **独立私有包** |
| `scripts/yan-worktree` | 1160 | git worktree 生命周期 | 先留域，phase 3 评估进 dia/包 |
| `scripts/yan-kb` | 130 + 4561 mjs | 知识检索 shim + 域语义 | 通用 `index/query/get/lint` 进 dia；`scene/rule/claims/baseline/alerts/record` 留 yan；见 `docs/migrations/yan-kb.md` |
| `scripts/yan-env` | 231 | env 白名单注入 | 通用安全能力，phase 3 进 dia |
| `scripts/yan-version` | 323 | yan 版本/发布流程 | 留 yan 域（工作发布语义） |
| `scripts/yan-ref` | 30 + 446 mjs | 稳定路径/生效指针 | 通用，phase 3 评估进 dia |
| `scripts/yan-mr` | 20 + mr-wait | GitLab MR 等待 | 留 yan 域（工作 GitLab） |
| `scripts/yan-schedule` | 19 + schedule.mjs | 节假日/大促窗口（不是后台任务） | 留 yan 域 |
| `scripts/yan-data-root`/`sync` | 64 | 数据根/同步 | 进 dia 数据根契约 |
| `scripts/yan-doctor` | 138 | 组合自检 | yan 域组合；单项检查调 dia |
| `core/knowledge` / `core/skills` | 2.3M / 12K | 工作域知识与技能 | **留 yan 域**（可打 kit） |
| `platform/dsh` / `opencode` | 219M | 宿主渲染与运行时 | 留域；通用渲染进 dia persona |
| `core/perm` / `dws-hub` / `channel` | — | 工作域权限/通道 | 留 yan 域 |

---

## 3. 三层归属（迁移后）

```
dia（框架）
  kb / ingest / audit / freeze / run / task ledger / persona / team / pricing
  + data-root 契约 + job 契约（声明式；不实现 OS 调度）
      ↑ 被依赖
dia-job（独立私有 GitHub 仓：`minonl/dia-job`）
  list/status/install/uninstall/run/stop/logs/doctor/selfcheck/bootstrap/registry/gc
  macOS launchd / Linux cron / Windows schtasks；无 yan 业务知识
      ↑ 被 yan-agent / dabo 调用
yan-agent@next（工作域入口）
  core/knowledge、core/skills、工作域策略、yan-mr/yan-schedule
  只保留 shim：yan-kb → dia kb；yan-task → 独立包；yan-* 安装入口
dabo-agent（个人域入口）
  个人知识/人格/策略；复用同一 dia + yan-task
```

**硬规则**：
- framework 不出现 `local.dia-job`、`yan-`、工作域路径、工作知识；
- dia-job 不出现 yan 业务任务名（`failed-task-report`/`nm-check` 留在 yan-agent 的 manifest）；
- yan-agent@next 不复制通用实现，只做参数/策略/内容。

---

## 4. yan-task 抽取设计

### 4.1 先解耦

当前硬编码（需参数化）：

| 现状 | 目标 |
|---|---|
| `YAN_DATA_ROOT` / `~/.yan-agent` | `DIA_JOB_ROOT` 或 `~/.local/share/dia-job`；旧根用全局 config 显式指定 |
| `local.dia-job-<name>` label | `--label-prefix`（默认 `local.task-`）；迁移时映射旧 label |
| `yan_main_checkout_of` / `yan_path_stability` / `yan_cmd_path_class` | 路径策略回调/参数；默认“当前 checkout” |
| `yan-ref` 调用 | 可选 resolver；未配置时用绝对路径 |
| `yan-task` 自有任务（selfcheck/update/...） | 移到 yan-agent manifest，不进包 |

### 4.2 契约（v1，兼容现有 CLI）

```text
yan-task list|status|doctor|platform
yan-task install <name> --cmd '<shell>' [--interval N|--calendar HH:MM] [--desc D] [--type periodic|bounded|service]
yan-task uninstall <name>
yan-task run|stop|logs <name> [-n N]
yan-task selfcheck [--dry-run]
yan-task bootstrap
yan-task registry
yan-task gc [--days N] [--dry-run]
```

退出码保持 0/1/2/3/4/5（现有契约）；`--json` 后补。

### 4.3 迁移阶段

| 阶段 | 动作 | 门禁 |
|---|---|---|
| P0 | 冻结 CLI/退码/state 格式；把现有测试作为 golden | 现有 `yan-task-*.test.sh` 全绿；记录 `list/status/doctor` 输出 |
| P1 | 新私有仓 `dia-job`：拷脚本 + `platform.sh` 子集 + 测试；参数化 root/label/path | 新仓测试全绿；旧仓 shim 委托；双跑输出 diff 为空 |
| P2 | dia 接 job 契约：`dia.json.jobs` + `dia job list/status` 调外部包 | dia 测试；未装包时明确报错，不静默 |
| P3 | 迁移已安装 launchd：旧 label → 新 label（保留映射/回滚） | 本机 `selfcheck` 不重建重复任务；`launchctl print` 对账 |
| P4 | yan-agent@next 去通用实现，只留 shim/manifest | `grep` 无 launchctl/cron；旧命令全部转发 |
| P5 | 双跑 1 周，默认切 next；旧分支保留回滚 | 任务成功率/漏跑率不升；回滚演练通过 |

---

## 5. yan-agent@next 的代码边界

**保留**：
- `core/knowledge/**`（工作规则/流程/坑）
- `core/skills/**`（工作技能）
- `core/perm`、`core/dws-hub`、`core/channel`（工作域通道/权限）
- `scripts/yan-mr`、`scripts/yan-schedule`（工作语义）
- `platform/{dsh,opencode}/**`（宿主渲染内容）
- `install.sh` / `install-cli`（只装 shim + 域内容）

**迁出**：
- `scripts/yan-task` → 私有 `yan-task` 仓
- `scripts/yan-kb` 的通用实现（index/query/get/lint 基础项）→ dia `kb`；`scene/rule/claims/baseline/alerts/record` 留 yan；yan 只留路由 shim
- `scripts/yan-env` → dia 通用 env 注入（phase 3）
- `scripts/yan-ref`、`yan-worktree` → 评估后进 dia 或独立包（phase 3）
- 通用数据根逻辑 → dia 契约

**验收（next 分支）**：
1. 同一份 `core/knowledge` 下，`yan-kb --scene S1` 输出与旧版逐字节一致；
2. `yan-task list/status/doctor` 输出与旧版一致（除路径前缀）；
3. `yan-mr` 仍能等 MR（工作域）；
4. `install.sh` 后 `PATH` 里的 `yan-*` 全部是 shim，`grep -R launchctl scripts/` 为空；
5. 回滚：`git switch main` + `install.sh` 恢复旧链接，任务不重复。

---

## 6. 风险

| 风险 | 处理 |
|---|---|
| launchd 测试会操作真实用户域 | 保留 `YAN_TASK_NO_LAUNCHD=1` 测试开关；迁移阶段先 dry-run |
| 旧 label 迁移产生重复任务 | 先 `list` 对账；新 label 前缀可配；提供 `adopt`/回滚 |
| bash 3.2 / Windows 差异 | 包内保留现有平台探测；CI 加 macOS + Linux；Windows 只做模板 |
| yan-ref / 路径稳定性耦合 | 抽成可选 resolver；默认绝对路径，不强制依赖 |
| 两个域重复维护 | yan-task 独立版本；dia 只声明 job，不复制实现 |
| 历史数据/任务名 | manifest 留在 yan-agent；包只认 name/cmd/schedule |

---

## 7. 下一步（需要人拍板）

1. **是否现在创建私有 GitHub 仓 `yan-task`**（推荐）：
   - 先放 P0 的契约测试与脚本副本，不接生产；
   - 保持 private，CI 只跑无 launchd 的单测。
2. 若同意，phase 1 的验收命令：
   - 新仓 `bash tests/run.sh`（从旧 `yan-task-*.test.sh` 迁）；
   - 旧仓 `scripts/yan-task list|status|doctor` 与新仓输出 diff；
   - `YAN_TASK_NO_LAUNCHD=1` 下 install/uninstall 幂等。
3. yan-agent@next 分支/仓库命名与默认切换时间，另定。


---

## 8. 命名落定（2026-10-30）

- 仓/包/CLI：**`dia-job`**（私有 `minonl/dia-job`）
- `yan-task` 保留一个 release 的兼容 shim：`exec dia-job "$@"`
- P1 基线已推送：`8720aed`（`yan-task` 行为兼容 fork；`tests/bootstrap.test.sh` 16 PASS、`tests/ref-cmd.test.sh` 25 PASS）
- P2.1（完成，`9bfead8`）：`DIA_JOB_ROOT` / `DIA_JOB_LABEL_PREFIX` / `DIA_JOB_OWN_TASKS` / 路径策略全部参数化；`lib/policy.sh` 不再依赖 yan `platform.sh`；`install.sh` 装到全局 `~/.local/share/dia-job`，配置读 `~/.config/dia-job/config`。
- 2026-10-30：yan-agent `scripts/yan-task` 已换成 shim，只转发全局 `dia-job`；拒绝 worktree 路径。只读验证 `list/status/doctor/selfcheck --dry-run` 通过，未执行写 launchd 的任务。
