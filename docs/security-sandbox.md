# Sandbox 细化设计（dia）

> 日期 2026-10-28。依据：dsh 本机源码实测、Hermes/Pi 取证、[/tmp/dia-sbx 实验]。
> 结论先行：**dia 不自建策略引擎**——复用 yan `dsh-watchdog` 的规则引擎；dia 只补它缺的三块：
> **网络默认关、状态目录保护、fail-closed 断言**。

---

## 1. 三家对照（都实测/源码级）

| 维度 | dsh | Hermes | Pi | **dia 目标** |
|---|---|---|---|---|
| 文件隔离 | seatbelt / bwrap / landlock / win ACL，**fail-closed** | local 无；Docker 有 | 无内建；示例扩展 | 复用 dsh |
| 网络 | **不在 seam 词汇里**（原文：no network/process/syscall/credential restrictions） | local 不限；Docker 默认有网 | 扩展白名单；失败静默降级 | **dia 自建 offline profile** |
| 进程/凭据 | 不管 | 不管（env 靠猜名字 → CVE-2026-9368） | 扩展同进程同权限 | env 白名单 + 明确不做进程隔离 |
| 审批对象 | — | 命令字符串 | 原始字符串，执行前还会被改写 | **argv hash 冻结** |
| 策略位置 | 部署配置 | 配置文件（`~/.hermes/config.yaml` 硬拒写） | 工作区内可写（被约束方可改） | 数据根只读 |
| 失败模式 | fail-closed（`SANDBOX_UNAVAILABLE`） | 双路径绕过 | **fail-open**（不支持就裸跑） | fail-closed + 显式逃生口 |

---

## 2. 威胁模型

| # | 威胁 | 现状 | 对策层 |
|---|---|---|---|
| T1 | 写工作区外（含 symlink 逃逸） | dsh 可挡（实测 seatbelt 解析真实路径） | OS 文件 |
| T2 | 出网外传（curl/git/webhook/DNS） | **dsh 不管** | dia offline profile |
| T3 | 读凭据（`~/.ssh`、`**/.env*`） | watchdog 红线可挡；dsh 文件模式可挡 | 策略 + OS |
| T4 | 篡改安全状态（audit/freeze/policy） | 无保护 | OS 只读 + 位置隔离 |
| T5 | 审批面 ≠ 执行面 | 三家都出过 | argv hash 冻结 |
| T6 | 第二执行路径（code tool/MCP/插件） | Hermes/Pi 都栽在这 | 单 seam 原则 |
| T7 | 审计缺失/可改 | 部分有 | append-only + 对账 |
| T8 | 凭据进子进程 env | Hermes CVE | env 白名单 |

**明确不做**：进程可见性隔离、内核级 syscall 过滤、多用户隔离、容器编排。这些交给容器/microVM；文档必须写明。

---

## 3. 执行 seam（唯一入口）

```
所有工具调用
   ├─ 在 dsh 内：dsh tool dispatch → watchdog pre-execute（决策/记账）→ dsh sandbox（文件）
   └─ 在 CLI/脚本：dia run → freeze 闸口 → dia policy（watchdog engine）→ OS wrapper → 子进程
```

**单 seam 硬规则**：

1. 任何"直接 spawn 子进程"的工具都属于违例（Hermes 的 `execute_code` 就是反例）。
2. MCP/插件新增的执行能力必须先过同一 Policy 接口，否则注册被拒（测试断言）。
3. `dia run` 是脚本侧唯一入口；绕过它的执行不在审计范围内——**文档与 doctor 都要标出来**。

---

## 4. 策略模型

```yaml
# ~/.local/state/dia/policy.yaml（600，agent 不可写）
file:
  mode: read-only            # read-only | workspace-write | full（默认 read-only）
  workspace: session-cwd     # 每会话一个根，不支持额外可写根（对齐 dsh）
network:
  mode: off                  # off | allowlist | on（默认 off）
  allowlist: []              # 域名；经代理，非直连
env:
  mode: allowlist            # 只透传显式声明的变量
  allow: [PATH, HOME, LANG, TMPDIR]
approval:
  freeze_argv_hash: true     # 批准时冻结，执行前校验
  unattended: deny           # cron/webhook 无人值守默认拒绝
redline:
  paths: ["~/.ssh/**", "~/.aws/**", "**/.env*", "**/*.pem"]
  commands: ["rm -rf /", "mkfs*", "dd of=/dev/*"]
```

**优先级**：session 只能**收紧**，不能放宽部署默认；项目级规则同样只收紧。
策略文件在数据根，agent 的沙箱必须对它**只读**（否则就是 Pi 的坑：被约束方能改策略）。

---

## 5. OS 包装（本机实测）

| 平台 | 文件 | 网络 | 实测 |
|---|---|---|---|
| macOS | `sandbox-exec` profile（deny file-write* + allow subpath workspace/tmp） | `(deny network*)` | 写外拒、symlink 逃逸拒、curl 000 |
| Linux | bwrap / landlock-run（复用 dsh 后端） | `unshare -n` 或 bwrap `--unshare-net` | 未验证（无 Linux 机器） |
| 都没有 | **拒绝高危执行**（exit 30 + degraded_reason） | 同上 | 待实现 |

实测命令与结果：

```
sandbox-exec -p '(version 1)(deny network*)(allow default)' curl https://example.com  → 000
sandbox-exec -p '(deny file-write*)(allow file-write* (subpath "/tmp/dia-sbx")) ...'  → 外部 Operation not permitted
通过 symlink 写外部                                                                   → 拒绝
```

---

## 6. 状态保护

| 状态 | 位置 | 保护 |
|---|---|---|
| audit | `~/.local/share/dia/audit/` | append-only；沙箱只读 |
| freeze | `~/.local/state/dia/freeze.json` | 600；沙箱只读；guard 在沙箱外 |
| policy | `~/.local/state/dia/policy.yaml` | 只读；哈希校验 |
| calls | `~/.local/share/dia/runtime/` | append-only |

**断言**：`workspace-write` 模式下，尝试写上述路径必须失败（测试用例；待实现）
`danger-full-access` 模式下 dia 必须**拒绝启动**（否则状态可被篡改）。

---

## 7. 审批与逃生口

- 审批时冻结：`argv + cwd + env 白名单 + wrapper` 的 hash；执行前重算，不一致即拒绝（T5）。
- 审批展示的内容必须逐字节等于执行内容；禁止审批后改写 input（Pi/Hermes 都栽过）。
- 逃生口只有两个：`--full-access`（需 `--i-am-human` + 记录 + 高 risk）和 waiver（限时/限任务）。
- **hardline 地板**：`rm -rf /`、写裸设备、fork bomb 连 `--full-access` 都拒绝（抄 Hermes）。
- 无人值守（launchd/cron）：默认 `deny`，必须有显式 `allow_unattended: true`。

---

## 8. 与 watchdog 的关系（复用，不重写）

| 能力 | 归属 |
|---|---|
| 路径/程序/命令判定、红线、五层规则 | **yan `dsh-watchdog`**（已有 23 个测试） |
| 审计格式（脱敏、按天滚动） | watchdog 的 `audit-YYYY-MM-DD.jsonl`；dia 读取并对账 |
| 网络 offline profile | **dia 新增**（watchdog 没有） |
| 状态目录只读断言 | **dia 新增** |
| freeze / guard / resume | **dia 新增**（watchdog 无冻结态） |
| 统一 seam 断言（禁止第二路径） | **dia 新增**（静态检查 + 运行时断言） |

---

## 9. 测试矩阵（可执行）

| # | 用例 | 期望 | 状态 |
|---|---|---|---|
| S1 | 写工作区外 | exit≠0 / Operation not permitted | ✅ 手工实测 |
| S2 | symlink 逃逸 | 拒绝 | ✅ 手工实测 |
| S3 | offline 下 curl | 失败（000/连接拒绝） | ✅ 手工实测 |
| S4 | 写 audit/freeze 目录 | 拒绝 | ⏳ 待实现 |
| S5 | 未知 sandbox 模式 | 拒绝执行（fail-closed） | ⏳ |
| S6 | 审批后改 argv | 拒绝（hash 不符） | ⏳ |
| S7 | 沙箱不可用 + 高危命令 | exit 30，不裸跑 | ⏳ |
| S8 | 子进程 env 含 token | 被剥离 | ⏳ |
| S9 | 绕过 `dia run` 直接执行 | doctor 报覆盖率缺口 | ⏳ |

---

## 10. 诚实边界（写进文档与 doctor）

1. 同 OS 用户下，agent 若拿到 `bash` 且不在沙箱内，能改任何文件——**语言与权限位都不是边界**。
2. dsh sandbox 只约束文件；网络必须 dia 自己关，关不掉就拒绝，不许"降级放行"。
3. 进程可见性、syscall、凭据内存隔离不做；需要请上容器/microVM（Hermes 的 Docker 旗标清单可抄）。
4. 审计只覆盖经过 seam 的调用；"全覆盖"在单机同用户条件下是**不可证明**的，只能对账。
