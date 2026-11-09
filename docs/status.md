# dia 状态页（单一事实源）

> 更新：2026-11-03（复核：`bun test tests` 286/39 全绿）。任何"现在做到哪了"的问题，以本页为准；其他文档是细节。
> 规则：状态必须能追到**命令/测试/提交**；没有证据的写"未验证"。

---

## 1. 文档清单

> 三方合起来的现状看 [`overview.md`](overview.md)；本页只管 dia 自己的阶段与证据。

| 文档 | 内容 | 状态（2026-11-03） |
|---|---|---|
| `overview.md` | **三方现状**：dia/yan/dabo 对照、能力面、缺口、文档地图 | 现行 |
| `vision.md` | **长期定位**：superagent/agent-team 工厂、平台经验库、fleet 边界 | 方向（不是现状） |
| `platforms/index.md` | **AI 工具平台经验库**：版本矩阵、断代与坑、验证命令、脱敏规则 | 现行（P0 持续补） |
| `security/credentials.md` | 凭据管理现状与调研待办（bw 分组粒度问题） | 待调研 |
| `HANDOFF.md`（仓库根） | 交接入口：复验判据 / 接手须知 / 坑 / 待决策指针 | 现行 |
| `status.md` | 本页：阶段、判决、待决策 | 现行 |
| `cli.md` | CLI 词表 + §4.1 实现状态 | 现行 |
| `persona-install.md` | persona/kit 安装：git → opencode/dsh 渲染 | 现行 |
| `monorepo.md` | core / kb / job / cli / wt 布局 | 现行 |
| `team.md` | 开发团队 4+3 | 现行 |
| `pricing.md` | 计价表与 `price` 命令 | 现行 |
| `dependency-registry.md` / `deps.jsonl` | 依赖登记格式（只追加） | **现行**：`deps.jsonl` 是单一事实源，`dia doctor` 派生校验（M1） |
| `versioning.md` | 多版本、semver、激活模式 | **部分**：多版本 + `use` 已实现；`activation` 未实现 |
| `architecture.md` | 三层职责、知识存储选型、抽取顺序 | **设计**（§7 待定已全部落定，见文内 2026-11-03 注） |
| `history/framework-bootstrap.md` | 早期启动与分发选型（已归档） | **归档**：方案未采用，实际分发是 `install.sh`，不要按它部署 |
| `entrypoints.md` | 用户入口矩阵 | **部分过时**：终端 dabo preset 已渲染；IM bridge 未写；`dia status` / `dia model` 不存在 |
| `kit-install.md` | kit 清单、渲染、生命周期 | **设计**：实现只有 `add/list/verify/remove`；`show/update/gc/create` 未做 |
| `install-guard-design.md` | **安装防呆**：脚本安装 vs npm 全局安装的抢链接判据、exit 3 逃生舱、`doctor install_shadow` | **实现**（D0.65 + `tests/install-guard.test.sh`） |
| `patching.md` | 本地 patch | **未实现**（`unknown command`） |
| `team-automation.md` | 计划→实现→验证全自动循环 | **未实现**（D0.6–D0.9 只跑通 mock / ACP 驱动） |
| `proposals.md` | `team next` 目标候选 | **v0 已实现**（`dia team next`，纯规则打分） |
| `security-sandbox.md` | 沙箱单 seam、档位、fail-closed | **部分未实现**（S4–S7） |
| `security/public-release.md` | 公开 release 门禁 | **BLOCKED until audit** |
| `acp-integration.md` / `ecosystem-*.md` | ACP 与生态选型 | **设计 / 参考**（server 未做） |
| `model-behavior.md` / `model-baseline-sidecar.md` | 客户端模型调控、基准 sidecar | **有据，未实施**（D2） |
| `evolution-process.md` | `(T,D,O)`、V 型、压缩 | **理论**（D3 未实施） |
| `host-control-surface.md` | opencode/dsh 控制面 L0/L1/L2 | 参考 |
| `migrations/yan-agent-current.md` | yan → dia 迁移现状 | **现行** |
| `migrations/*`（其余） | 当时的迁移/清理结论 | **留痕**：可能已被推翻（`yan-kb-parity` 的「main 仍旧」已过期） |
| `research/*`、`review/*`、`research/h0/*` | 实验与验证报告 | **留痕** |

---

## 2. 设计支柱 × 证据 × 判决

| # | 支柱 | 证据 | 判决 | 下一步 |
|---|---|---|---|---|
| 1 | 进化过程（观测→记录→蒸馏→评审→尝试→度量→调整） | 理论：混合主动、JCS、MHC；本系统**未验证** | **有理论依据，未实证** | 用 4-fixture 跑完整一圈 |
| 2 | `(T,D,O)` 多维状态 | 理论：types×levels、SA、信任校准；Δ/自报已被纠正 | **部分支持，需实验** | state 事件 + 一次样本 |
| 3 | 审计/冻结（H1/H2） | 29 测试、E2E 9 段、独立验证修复 P1/P2 | **支持（局部）** | 哈希链（M3） |
| 4 | 独立验证 | pilot 发现 10 问题、其中 2 个严重且自测全绿 | **支持** | 每里程碑固定执行 |
| 5 | 沙箱 | dsh 只文件；seatbelt 网络/路径/symlink 实测；状态保护未实现 | **部分** | S4–S7 |
| 6 | 知识索引 / 采集 | yan 103 篇基线；257 episode；源只读实测；opencode 会话跨 project 已覆盖 | **支持（管线）** | 保留策略 |
| 7 | 模型调控 | 五家源码对照；baseline/sidecar 设计 | **有据，未验证** | ModelSpec + canary |
| 8 | 验收双票 / 路由 | 用户决定；无实验 | **假设** | H13/H14 |
| 9 | 团 / 档位 | 无先例、无第二场景；已 defer | **无证据** | H4/H5（暂缓） |
| 10 | ACP / 生态 | 五家服务端 + acpx；无 dsh 桥 | **支持（参考）** | 先做 server |
| 11 | 团队 4+3 | 首次独立验证即回本 | **支持** | 固化为门禁 |
| 12 | 依赖/记录治理 | SBOM/PITR/GDPR/AU-11 标准 | **有据，未实现** | M1–M5 |

**一句话判决**：
> **"进化过程 + 审计/门禁 + 证据纪律 + 模型基准"有搞头；"引擎/团/档位"没有证据，已被降级。**
> 继续投入的条件：D1–D3 能跑出真实数据；否则停止扩张。

---

## 3. 计划状态

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| D0 | kb / ingest / audit / freeze / run / resume | **完成** | 29 测试 + E2E 9 段（Node+Bun） |
| D0.5 | 独立验证 + 修复 P1/P2/P5/P7/P10 | **完成** | `docs/review/verification-2026-10-28.md` |
| D0.6 | task 台账 + 团队状态机 + 验收门禁（mock） | **完成** | 43 测试 |
| D0.7 | ACP TeamDriver（opencode） | **成功/失败路径均跑通** | 成功→accept；失败→escalated；tokens 记账；只读副本+脱敏+清理 |
| D0.8 | ACP TeamDriver（dsh） | **成功/失败路径均跑通** | 每角色 profile（只读沙箱）；4 次调用/34k tokens；失败→escalated |
| D0.9 | H9/H10：角色 JSON 契约 + 修复重试 | **实现+单元测试** | 68 测试；build/smoke/e2e（node+bun）通过；真实模型修复率待测 |
| D0.10 | H0：三层覆盖分类实验 | **推翻（严格口径）** | 20/140 抽样：17/20=85%；宿主适配缺口 3；成本未测；见 `docs/research/h0/report.md` |
| D0.11 | yan-agent 迁移 dia | **本机已切换；dsh host 已补；剩余项见清单** | `yan` persona 生效；dsh profile 3091；AGENTS/default agent 已切；见 `docs/migrations/yan-agent-current.md` |
| D0.12 | yan-kb → dia kb 能力矩阵 | **K2.5 next 已切；main 仍 old** | next 默认 dia + auto-index；old 可回滚；main/现网未替换；见 `docs/migrations/yan-kb-parity.md` |
| D0.13 | dia monorepo（core/kb/job/cli） | **M3b 完成；M4 归档** | `packages/kb`、`packages/job`、`packages/cli`；独立 `dia-job` 已归档；见 `docs/monorepo.md` |
| D0.14 | public release gate | **BLOCKED until audit** | 必须完成脱敏 + git 历史清洁 + `dia-security` pass；见 `docs/security/public-release.md` |
| D0.15 | dia global install + CLI package (M3a/M3b) | **完成** | `install.sh` + `packages/cli`；根 `src/cli.ts` 兼容；88 tests |
| D0.16 | Python 清理 | **完成** | experiments/TS + `packages/job/lib/json.mjs`；全仓无 python3；见 `docs/migrations/no-python.md` |
| D0.17 | persona/kit 安装形态（kit + 内联内容 + scope + 委派） | **完成** | `src/{kit,scope,active,env,doctor}.ts`；`tests/{kit,scope,env,active-doctor}.test.ts` |
| D0.18 | 生效版本指针 + 审计 | **完成** | `dia persona use/show`；`state/active.json(l)`；scope 先读指针 |
| D0.19 | 凭据注入（白名单 → 子进程） | **完成** | `dia env list/check/run`；不回显、redact、不进 argv |
| D0.20 | 组合自检 | **完成** | `dia doctor`（persona/kit/knowledge/dsh preset/wt；exit 0/1/2） |
| D0.21 | worktree 抽取 `packages/wt` | **完成** | 7 处 python→node；`dia wt`；4 套测试原样迁移全绿 |
| D0.23 | doctor 平台版本自检 | **完成** | `platform:opencode` / `platform:dsh` 报版本（缺宿主 = warn，不判红）；`tests/active-doctor.test.ts` |
| D0.44 | 配置迁移走 LLM 任务 | **完成** | `docs/migrations/llm-migration.md`：升级只改声明；迁移=任务+判据+回滚；禁止代码里堆版本分支（安全敏感/原子场景例外） |
| D0.75 | job 根双份收敛 | **完成** | `jobRootResolved` 沙箱永不回退 legacy；`dia-job` 目录缺失不再静默换根；`job install` 拒绝临时根注册（`E_JOB_ROOT_EPHEMERAL`）；uninstall 校验 plist 归属（防误删另一根）；`dia job migrate --from … [--dry-run]` 逐条重建+校验+清旧；doctor 新增 `job.root`（split-brain fail / 旧根残留 warn） |
| D0.74 | collab enable 顺带首刷 board | **完成** | enable 在注册/校正定时后立即 `observe` 一次，board.interval_s 当场对齐 job（否则要等 300s，doctor 先报不一致）；测试覆盖 |
| D0.73 | observer interval 单一事实源 = job registry | **完成** | `observe`/`board --refresh` 按 job 注册值写 board；`collab enable` 校正（缺则装、不对则重装，绝对路径 + DIA_ROOT/DIA_HOME 固化）；`disable` 对称卸载并清派生 board；`doctor` 修复命令统一 `dia collab enable`、非 60 倍数报「不可调度」；`collab status` 显示 observer |
| D0.72 | 内置 kit 升级不再卡冲突 / 切版本自动重渲染 | **完成** | `kit.install({force})` 透传到 dry-run 规划（否则 `E_CONFLICT` 提前抛）；内置 kit 装配强制覆盖并备份；`persona use` 后自动 `render`；`render` 覆盖 skills/bin 软链（按真实指向判 drift，内容相同也能修） |
| D0.71 | 知识索引自动建（派生物不等人） | **完成** | `persona add/update/use` 成功后 best-effort 建索引；doctor 缺索引文案改为「首次检索或下次装/切换会自动建」；测试覆盖 add 自动就绪与索引被删的 warn |
| D0.70 | README/Pages 与代码同构 | **完成** | `scripts/lib/user-docs.mjs` 从 `--help` usage + package.json 生成安装/首次使用/更新/卸载/命令表；README 与 `docs/index.md` 共用片段（marker 拼接，`docs:check` 进 CI）；补齐 npm 12 拦截脚本、bun/pnpm、卸载序列、旧路径 |
| D0.69 | npm ≥ 11 allowScripts 兜底 | **完成** | 文档给出 `--allow-scripts=@minonl/dia` 一次性放行 + 长期 config；`dia update` 成功后在进程内补一次 `defaultMsg.ensure(force)`；doctor 的 bootstrap 两条文案都指向 `dia postinstall` |
| D0.68 | postinstall 自举 + 删除 install.sh | **完成** | npm 全局安装自动跑 `postinstall`（装配内置 kit + 自举戳；CI/非全局/`--ignore-scripts` 安全跳过）；`dia postinstall` 手动补跑；`dia migrate data` 取代 `--migrate`；删除 `install.sh` 与 3 个守卫测试 |
| D0.67 | npm 单一安装通道（收口） | **完成** | `dia update` 脚本安装分支统一引导 `npm i -g` + 回链；`E_WT`/`job`/`doctor wt` 报错不再让人跑 `install.sh`；`install_shadow` 修复命令统一 npm；README 主流程只留 npm，`install.sh` 降为开发/离线 |
| D0.66 | 内置能力分层（dia-msg 用户零操作） | **完成** | `kit.install` 原子换入 + 数据根锁；版本 semver 排序；`installDir()` 校验；`collab enable` 失败退 32；自举戳 `~/.dia/state/bootstrap.json` + `doctor bootstrap` 检查；`install_shadow` 降 warn；设计见 [builtin-kit-design.md](builtin-kit-design.md) |
| D0.65 | 安装防呆：脚本安装不抢包管理器全局安装 | **完成** | `install.sh` 守卫（目标 bin 属于包管理器全局安装且为 `command -v dia` 命中项 → exit 3，零改动）：npm/bun 软链看 `node_modules/@minonl/dia`，pnpm/yarn shim 看内容，volta 看 bin 目录；放行 = `DIA_ALLOW_SCRIPT_INSTALL=1` / `--dry-run` / **bin 目录被重定向**（`--home` 等只改安装目录不算沙箱）；装完打印 `effective:`；`doctor install_shadow` 双向一致判定（含 shim）；`tests/install-guard.test.sh` + `tests/install-guard-strict.test.sh` |
| D0.64 | 复制过滤按相对路径判断 | **完成** | 绝对路径匹配 `node_modules` 会误伤 npm 全局安装（kit 整树被过滤 → `E_KIT_EMPTY`）；改 `copyFilter(base)` 用相对路径，persona/kit 共用 |
| D0.63 | 运行时数据 `.data/` 不进快照、不参与哈希 | **完成** | `TREE_SKIP`（kit/persona 共用）：安装复制与 `hashTree`/verify 都跳过 `.data`，防运行时写入造成 verify 假漂移 |
| D0.62 | persona 旧版技能软链视为受管 | **完成** | `linkManaged` 同时认 `~/.dia/kits/**` 与 `~/.dia/personas/**`；`persona update` 升级不再需要 `--force` |
| D0.61 | kit 空内容拒绝 + doctor 只查引用 kit | **完成** | `kit add` 拒绝空清单/空树（E_MANIFEST/E_KIT_EMPTY）；doctor 按 persona lock 的 kits 校验，孤儿不再拖红 |
| D0.60 | persona --force 覆盖内联内容 / update --force | **完成** | `kit.renderContent` 支持 force（写盘前备份到 `backups/force-*`）；`persona update --force`；版本冲突错误给可执行提示；`tests/kit.test.ts` |
| D0.59 | 包内容守卫 | **完成** | 单测覆盖 docs 回退；publish workflow 发布前断言 tarball 含 docs/deps.jsonl + docs/platforms/registry.json（防「发完才发现缺文件」） |
| D0.58 | 推送前敏感扫描 | **完成** | `dia wt adopt` 的 pre-push 扫描新增行：真实家目录/私钥/token 形态；`DIA_WT_GUARD_SCAN=0` 逃生；`adopt.test.sh` 34 pass |
| D0.57 | 独立安全审核 | **pass（with caveat）** | 子会话独立审核：凭据干净；main 树 P1/P2 已修（experiments 移除、内部命名/业务名脱敏、deps 可移植）；**分支 feat/msg-collab-grill 待清理** |
| D0.56 | `dia update` 按安装方式分流 | **完成** | npm 包 vs 脚本安装（`install.json` 记来源）；防止装到不在 PATH 的 npm prefix；`tests/update.test.ts` 4 例 |
| D0.53 | 安装物/数据分离 | **完成** | `DIA_INSTALL_DIR`（install.sh 与 paths.installDir 一致，优先读）；`--migrate` 只搬数据子目录；doctor 打印 install+data、同根 warn |
| D0.52 | launchd 安装脚本 | **完成** | `packaging/launchd/{install,uninstall}.sh`（默认 dry-run）；日志落 `~/.dia/logs` |
| D0.51 | 快照隔离评估 | **完成（文档）** | `docs/security/snapshot-isolation.md`：威胁模型、A–E 方案对比、路线与触发条件；结论：短期不加沙箱，敏感任务走 `--dsh` |
| D0.50 | 文档内链检查 | **完成** | `scripts/docs-link-check.mjs`：相对链接存在性 + 不越出 `docs/`（Pages 根）+ 可选 `--remote`；CI 跑；`docs:index` 的 llms 入口改绝对 URL |
| D0.49 | `dia update` 自更新 | **完成** | `dia version` 改读 package.json；`update --check`（领先 latest 不算旧）；`install.sh` 分发 package.json；`tests/update.test.ts` |
| D0.48 | npm 预发布 dist-tag | **完成** | `publish.yml` 按版本自动 `next`/`latest`；
| D0.47 | npm Trusted Publishing | **完成（待配置侧）** | `.github/workflows/publish.yml`：release published → OIDC → `npm publish --provenance`；`publishConfig.provenance=true`；仓库不放 token。npmjs 侧需配 Trusted Publisher（repo + workflow 名） |
| D0.46 | npm 包准备 | **完成（待发布）** | 去掉 `private`、`publishConfig.access=public`、`files` 含 `packages/{wt,job}`；`npm pack` + 本地全局安装实测通过 |
| D0.45 | 发版脚本 | **完成** | `scripts/release.sh <patch|minor|major|x.y.z> [--dry-run]`：干净 main + 同步校验 → bump → tag → push → `gh release create`（私有仓默认不发 npm） |
| D0.43 | broker 取用写主审计链 | **完成** | `DIA_BW_AUDIT_CHAIN=1` 时成功取用追加 `audit.jsonl`（tool=bw、note=ENV=item，无值）；默认关，避免测试/日常噪声；失败只留 `bw.jsonl` |
| D0.42 | env run 接 bw 白名单 | **完成** | `dia env run --bw KEY=item …`：白名单 + broker 取用合并注入；子进程环境剔除 `BW_SESSION`/`BW_PASSWORD`；`serve --passwordfile` 支持启动解锁；`tests/bw-cli.test.ts` |
| D0.41 | accept 接 CI 门禁 | **完成** | `dia team accept <id> --pr N [--repo R] [--merge]`：先验 `gh pr checks` 全绿，绿才接受；`--merge` 顺带 squash 合并；`tests/team.test.ts` |
| D0.39 | 合并门禁脚本 | **完成** | `scripts/pr-merge.sh`：CI 全绿才 `gh pr merge`（私有仓无 branch protection）；`tests/pr-merge.test.ts` |
| D0.40 | bw broker launchd 模板 | **完成** | `packaging/launchd/com.minzhao.dia-bw-broker.plist.template` + README（load/unload/检查） |
| D0.38 | bw broker 常驻进程 + 审计行 | **完成** | `dia env bw serve/get`：unix socket（0600，不监听 TCP）、单进程持有 session；每次取用写 `audit/bw.jsonl`（env/item/task/ok，**不记值**）；client 优先走 broker，不在才回落本地 session；`tests/bw-broker.test.ts` |
| D0.37 | 团队快照移出 run 目录 | **完成** | 快照落系统临时目录（`snapshots.json` 登记，结束即删）；角色会话不再能顺着相对路径摸到验收证据；277 tests |
| D0.36 | bw 单会话 broker（POC） | **完成** | `dia env bw status/unlock/lock/run`：session 只落 0600 文件、永不打印/进 argv；`--map KEY=item` 只注入声明键；子进程环境剔除 `BW_SESSION`/`BW_PASSWORD`；取不到即 fail-closed；`tests/bw*.test.ts` |
| D0.35 | dsh 驱动自动修复对齐 ACP | **完成**（团队产出 + 人工补齐） | 抽出 `repairRedteamHighs`（ACP/dsh 共用）：high → builder 修 → 复跑判据（20MB buffer / 600s）→ 复检；dsh 成功路径写 `run.json`；268 tests |
| D0.34 | 判据证据由 gate 现场重跑 | **完成**（团队升级后人工补齐） | gate 只认任务台账的 judge，在 `run.json` 记录的 workspace 里重跑；忽略任何角色写的 `judge.json`；mock run 不再能当验收证据；`tests/team.test.ts` 覆盖 |
| D0.33 | audit off-box checkpoint | **完成**（团队产出） | `DIA_AUDIT_CHECKPOINT`：两阶段（pending 公告 → 落盘 → 确认）、`checkpoint_id`、路径校验（绝对/不在审计目录/非常规文件）；`protection=anchored:*` 判定；248 tests |
| D0.32 | doctor 渲染产物检查 | **完成**（团队产出） | `persona.renderDrift`（只读，复用 compareDir 口径）+ `persona.render` 检查：宿主产物被改/丢失 → warn 并给 `dia persona render <id>`；跳过场景不拉红；237 tests |
| D0.31 | redteam high 自动修复 | **完成** | `team gate` 遇 high 判 fail；`run --acp` / `run --dsh` 同一套闭环：high 回灌 builder 修一轮 → 复跑判据（`run.json` 的 workspace）+ 复检一轮，仍不达标则 escalated；`redteam.json` 带 `repaired/round`；`tests/team-acp.test.ts` 两条驱动路径均覆盖 |
| D0.30 | 清理过期内容 | **完成** | `docs/framework-bootstrap.md` → `docs/history/`（归档并标注不采用）；删除 `doctor.ts` 未用常量；全仓无 `deps.yaml` 残留引用 |
| D0.29 | audit 哈希链（M3） | **完成**（团队自动循环 + 人工修正） | `audit append` 写 `seq/prev_hash/hash`；`audit verify --chain`；锚点 `audit/head.json`（原子写，截断/锚点缺失 fail-closed）；mkdir 锁串行化写入；坏行判链断点；离箱检查点 `DIA_AUDIT_CHECKPOINT`（两阶段公告/确认写、head→checkpoint 顺序、写失败回滚、同域伪造/回滚/未公告行检出、缺失/损坏 fail-closed、未配置仅告警）；`tests/audit.test.ts` 46 例 |
| D0.28 | ACP 默认超时 10 分钟 | **完成** | `DEFAULT_ACP_TIMEOUT=600000`（180s 实测会掐断 builder）；`tests/team.test.ts` |
| D0.27 | doctor 知识索引新鲜度 | **完成**（团队自动循环产出） | `packages/kb` 的 `indexStatus`（只读探测，不建目录）+ doctor 三态：目录缺失 fail / 索引缺失·落后·外部根 warn（带重建命令）/ 一致 ok；`tests/active-doctor.test.ts` |
| D0.26 | `dia deps list/record` | **完成** | 追加与派生视图进 CLI；`tests/deps-cli.test.ts` |
| D0.25 | 依赖登记迁移 JSONL + 校验（M1） | **完成** | `docs/deps.jsonl`（只追加，同 id 取最后一行）+ `src/deps.ts`（PATH/版本/路径探测）+ `doctor` 的 `deps` 项；`tests/deps.test.ts` |
| D0.24 | 平台注册表（单一事实源） | **完成** | `docs/platforms/registry.json`（支持范围/实测版本/坑）+ `src/platforms.ts` 版本判定 + `doctor` 派生视图；`install.sh` 分发注册表；`tests/platforms.test.ts` |
| D0.22 | 安装/自检一致性修复 | **完成** | `doctor` 多 persona 逐项自检；`scope` 旧 lock 缺 `content` 时读 `dia.json` 兜底；`render --check` 跳过宿主自写 `cordis.yml`；`persona add --force`（先备份） |
| D1 | doctor 依赖校验（M1）+ audit 哈希链（M3） | **M1 完成；M3 未开始** | `src/deps.ts` + `doctor` 的 `deps` 项；哈希链未做 |
| D2 | ModelSpec + 首次基准 + 事故 sidecar | **未开始** | 设计完成 |
| D3 | state 事件 + `(T,D,O)` 视图 | **未开始** | 设计完成 |
| D4 | 私有 canary（PR + episode） | **未开始** | 设计完成 |
| — | 热更新边界 | **persona 不热更（H19）**；工具新增可公告（H17），移除仅 `in-history` | 实现能力探测 |
| — | watchdog 抽取 | **defer**（2026-11-04） | 无 license、测试不可移植 |
| — | 团 / 档位 | **defer** | H4/H5 未验证 |
| — | npm 发布 / ACP server | **未开始** | package `private: true` |

---

## 4. 团队与门禁

- 固定：架构 / 实现 / 验证 / 档案；按需：红队 / 研究 / 发布。
- 门禁：无判据不开工；**无独立验证不合并**；行为改动人批；自签 = 违规。
- 首轮指标：独立验证发现率 100%（实现者自测全绿）。

---

## 4.1 已定（2026-10-28）

- 默认生效时机：**next-session**（运行中会话不惊动）。
- patch 范围：**限定**——提示词/知识/技能实现可改；capabilities/安全策略/凭据不可改。
- 版本：semver + `breaking` 标记；dia 建议、硬检查强制；模型审查只补充不推翻。

## 5. 待决策

1. D1 先做 doctor 还是 audit 哈希链？
2. D2 的 ModelRunner 以 dsh 为首，是否需要同时接 opencode？
3. D3 的 state 事件是否先只做"深度 + 障碍"两类？
4. D4 的 PR 题源是否只在本地生成、不进任何远程？

---

## 6. 不做什么（防止漂移）

- 自建沙箱 / 重试 / 压缩（复用 dsh）。
- 公共市场 / 自动安装。
- 多引擎运行时。
- 无证据的团/档位扩张。
- 未经过独立验证就宣布完成。
