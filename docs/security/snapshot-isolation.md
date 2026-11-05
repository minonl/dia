# 团队快照隔离评估（2026-11-05）

> 现状：verifier / redteam 跑在系统临时目录的**副本**里；`runs/<id>` 0700；gates 现场重跑判据。
> 结论先行：**当前是「降低旁路机会」，不是隔离**。同 OS 用户的进程仍可用绝对路径读写 `~/.local/share/dia`。
> 本文件评估要不要、以及怎么补到「真隔离」。

---

## 1. 威胁模型

| 角色 | 能力 | 想干的事 |
|---|---|---|
| builder | 在 worktree 里读写、跑命令 | 正常实现；也可能越界改验收证据 |
| verifier / redteam | 只在快照里工作，但工具含 bash/read | 读 `runs/<id>/judge.json`、改状态、伪造证据 |
| 同机其它进程 | 同一 OS 用户 | 读 session、改审计、换 persona 文件 |

真正的边界只能是**内核级**（文件系统命名空间 / 独立用户 / 容器），不是路径约定。

---

## 2. 候选方案

| 方案 | 能挡什么 | 代价 | 现状可用性 |
|---|---|---|---|
| **A. dsh 沙箱**（dsh 自带 fs 沙箱/审批） | 只挡文件写；网络与进程仍看宿主配置 | 低（已有 profile 机制） | dsh 驱动可直接用；ACP 驱动用不上 |
| **B. macOS seatbelt**（`sandbox-exec`，deprecated 但可用） | 文件/网络/进程的强限制 | 每平台一套 profile；Apple 未承诺长期支持 | 本机可用；Linux 不适用 |
| **C. Linux bubblewrap / namespaces** | 强（独立 mount ns） | 需要 root/用户命名空间；容器里受限 | levm 可试 |
| **D. 容器（podman/docker）** | 最强（独立 fs/net/user） | 重；每次 run 起容器、镜像分层；CI 成本 | 开发机有 podman 才能用 |
| **E. 换成独立 OS 用户跑角色** | 挡同用户旁路 | 权限/文件属主复杂；launchd 配置成本 | 不推荐 |

---

## 3. 推荐路线（不做大改）

1. **短期（已做）**：快照移出 `runs/`、run 目录 0700、judge 由 gate 重跑、mock 不可当证据。
2. **中期（按需）**：dsh 驱动默认开 dsh 沙箱（A）；ACP 驱动文档标注「无沙箱」，敏感任务强制走 `--dsh`。
3. **长期（有真实事故再上）**：Linux 用 bubblewrap（C），macOS 用 seatbelt（B）；容器（D）只在 CI 批量跑时评估。

**触发条件**（满足任一才投入）：
- 出现「角色改了 run 目录/judge」的实锤；
- 多租户/多人共用同一台机器跑 dia team；
- 合规要求「agent 不能读其它任务数据」。

---

## 4. 不做

- 不自己实现沙箱（复用宿主/OS）。
- 不在 ACP 驱动里假装有隔离（文档必须写清）。
- 不为隔离改 judge/审计协议（它们已独立）。
