# Patch：对已安装 persona / kit 的本地补丁

> 日期 2026-10-28。参考 npm/patch-package，但**只作用于本地安装副本**，不改上游。
> 用途：本地迭代、紧急修复、试验性调整；不替代 `update`。

---

## 1. 命令

```bash
dia patch create dabo --file changes.diff --reason "..."   # 生成 patch 元数据
dia patch add dabo --file <patch-dir|diff>                 # 应用到当前安装版本
dia patch list dabo
dia patch verify dabo
dia patch revert dabo --id <patch-id>
```

- patch 只作用于 `~/.local/share/dia/personas/<id>/<version>/`（或 kits）；
- **不改上游 git**；升级到新版本时尝试重放，失败即冲突。

---

## 2. 格式

```
patches/<id>/<patch-id>/
├── patch.json      # base_version, base_hash, author, reason, files[], created_at
└── changes.diff    # 统一 diff（仅文本文件）
```

`patch.json` 必填：

```json
{
  "id": "p-20261028-1",
  "persona": "dabo",
  "base_version": "1.2.0+abc1234",
  "base_hash": "sha256:...",
  "files": ["agents/dabo.md"],
  "reason": "本地实验：调整排障口吻",
  "author": "min",
  "created_at": "2026-10-28T12:00:00Z"
}
```

---

## 3. 应用流程（双重闸门）

```
verify base（版本+hash 必须匹配）
  → dry-run（只显示 diff）
  → 硬检查（文件白名单/大小/无二进制/不改 capabilities）
  → 模型审查（diff 是否引入越权、注入、策略弱化）
  → 应用 → 更新 dia.lock（记录 patch id）→ render
  → 审计事件
```

- **硬检查不过 = 拒绝**；模型只做补充，**不能推翻硬失败**。
- 允许 patch 改：提示词、知识、技能实现。
- **不允许** patch 改：`capabilities`、安全策略、版本号、签名/凭据字段（需走 waiver + 人批）。

---

## 4. 升级时重放

`persona update` 到新版本时：

1. 先应用新版本；
2. 逐个 patch 尝试 `git apply --3way`（无 git 时用自有 3-way）；
3. 成功 → 记录新 base；失败 → **冲突**，该 patch 标记 `stale`，新版本仍可用，但提示"patch 未应用"；
4. 冲突不阻断新版本，但 `dia status` 显示 `patch conflict`，并保留旧版本可回滚。

---

## 5. 安全与审计

- patch 文件大小上限（如 256KB）；只允许文本扩展名。
- patch 内容过 secret 扫描；命中即拒绝。
- 每个 patch 记录 `applied_at / applied_by / base_hash`；`dia patch list` 可查。
- patch 也是"变更"，进入审计与回滚链；**不因是本地 patch 就免审计**。

---

## 6. 与版本号的关系

- patch **不改变** persona 版本号；它是本地覆盖层。
- 若要进入上游：导出 diff → 提 PR → 上游 bump patch/minor → 撤销本地 patch。
- `dia patch export dabo --id <id>` 输出可提交的 diff。
