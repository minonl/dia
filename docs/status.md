# dia 状态页（单一事实源）

> 更新：2026-10-28。任何"现在做到哪了"的问题，以本页为准；其他文档是细节。
> 规则：状态必须能追到**命令/测试/提交**；没有证据的写"未验证"。

---

## 1. 文档清单

| 文档 | 内容 | 状态 |
|---|---|---|
| `docs/evolution-process.md` | `(T,D,O)`、V 型、深度、压缩 | 现行 |
| `docs/security-sandbox.md` | 单 seam、默认档位、fail-closed | 现行（部分未实现） |
| `docs/host-control-surface.md` | opencode/dsh 控制面 L0/L1/L2 | 现行 |
| `docs/model-behavior.md` | 客户端模型调控、五家对照 | 现行 |
| `docs/model-baseline-sidecar.md` | 首次基准 + 事故 sidecar + 观察名单 | 现行 |
| `docs/dependency-registry.md` / `deps.yaml` | 依赖登记与原始记录 | 现行（doctor 未实现） |
| `docs/ecosystem-integration.md` | 插件/ACP/包格式 | 现行 |
| `docs/ecosystem-positioning.md` | 常驻入口与生态位（dws-hub 优先） | 现行 |
| `docs/entrypoints.md` | 用户入口与 agent 命名（dabo ≠ dia） | 现行 |
| `docs/persona-install.md` | persona/kit 安装：git → opencode/dsh 渲染 | 现行（未实现） |
| `docs/cli.md` | CLI 动作词表（add/remove/create/update/render/verify） | 现行 |
| `docs/versioning.md` | 多版本、semver/双重审查、激活模式 | 现行 |
| `docs/patching.md` | 本地 patch 设计 | 现行（未实现） |
| `docs/research/*` | 理论、基准、生态、opencode 会话分区 | 现行 |
| `docs/research/h0/*` | H0 三层覆盖实验：样本、标注、报告 | 留痕 |
| `docs/migrations/yan-agent-next.md` | yan-agent@next → dia 的边界与阶段 | 现行 |
| `docs/review/*` | 复用评审、验证报告 | 留痕 |
| `docs/team.md` | 开发团队 4+3 | 现行 |
| `docs/team-automation.md` | 全自动循环与验收包 | 现行（未实现） |
| `docs/architecture.md` / `framework-bootstrap.md` | 早期架构与启动方案 | **部分过时**（以本页为准） |

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
| D0.11 | yan-agent@next 迁移设计 | **设计完成；P2.1 + shim 已落** | `dia-job` 全局安装、路径策略项目无关；yan-agent `yan-task` 已转发；见 `docs/migrations/yan-agent-next.md` |
| D0.12 | yan-kb → dia kb 能力矩阵 | **K0/K1 部分完成** | 20 条 golden 已冻结（工作域本地）；`dia kb query/review` 已补；`path` 待做；见 `docs/migrations/yan-kb.md` |
| D0.13 | dia monorepo（core/kb/job） | **M2 完成** | `packages/kb` 已抽离，根 re-export；`dia kb query/review`；见 `docs/monorepo.md` |
| D0.14 | public release gate | **BLOCKED until audit** | 必须完成脱敏 + git 历史清洁 + `dia-security` pass；见 `docs/security/public-release.md` |
| D1 | doctor（依赖校验 M1）+ audit 哈希链（M3） | **未开始** | — |
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
