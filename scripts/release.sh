#!/usr/bin/env bash
# release.sh —— 打版本 + GitHub Release（发布全程不碰主 checkout 的 pre-push）
#
# 用法：scripts/release.sh <patch|minor|major|x.y.z> [--dry-run]
# 前置：main 干净且与 origin 同步；CI 由 PR + branch protection 保证
#
# 流程：临时 worktree 里 bump → 推分支 → PR → 等 checks → squash 合并 → 取 origin/main 打 tag → 推 tag
# 为什么不在主 checkout 直接做：dia wt adopt 后主 checkout 的 pre-push 拒绝一切 push
# （含 tag/feature），用 --no-verify 等于绕过守卫；发布也应当走 worktree + PR。
set -uo pipefail
BUMP="${1:-}"; DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
case "$BUMP" in patch|minor|major|[0-9]*.[0-9]*.[0-9]*) ;; *) echo "usage: $0 <patch|minor|major|x.y.z> [--dry-run]" >&2; exit 2 ;; esac

[ -z "$(git status --porcelain)" ] || { echo "E_DIRTY: 工作区不干净" >&2; exit 1; }
CUR="$(git branch --show-current)"; [ "$CUR" = main ] || { echo "E_BRANCH: 必须在 main（当前 $CUR）" >&2; exit 1; }
git fetch -q origin && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "E_SYNC: main 与 origin 不一致" >&2; exit 1; }

OLD="$(node -p "require('./package.json').version")"
NEW="$(node -e '
const [a,b,c]=require("./package.json").version.split(".").map(Number);
const b2=process.argv[1];
const out=b2==="patch"?[a,b,c+1]:b2==="minor"?[a,b+1,0]:b2==="major"?[a+1,0,0]:b2.split(".").map(Number);
console.log(out.join("."));' "$BUMP")"
REPO="${REPO:-minonl/dia}"
echo "bump: $OLD -> $NEW"
if [ "$DRY" = 1 ]; then
  echo "dry-run: worktree bump → PR → 等 checks → squash 合并 → tag v$NEW → push tag → gh release create"
  exit 0
fi

BR="chore/release-v$NEW"
TMP="$(mktemp -d)"; WT="$TMP/wt"
cleanup() {
  git worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  git branch -D "$BR" >/dev/null 2>&1 || true
}
trap cleanup EXIT
git worktree add -q --detach "$WT" main || { echo "E_WT: worktree 创建失败" >&2; exit 1; }
git -C "$WT" checkout -q -b "$BR"

node -e 'const fs=require("fs");const p=require(process.argv[1]);p.version=process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2)+"\n")' "$WT/package.json" "$NEW"
git -C "$WT" add package.json && git -C "$WT" commit -q -m "chore(release): v$NEW"
git -C "$WT" push -q -u origin "$BR" || { echo "E_PUSH: 分支推送失败" >&2; exit 1; }

gh pr create --repo "$REPO" --head "$BR" --base main --title "chore(release): v$NEW" --body "版本号 v$NEW；合后打 tag 并触发 publish。" >/dev/null
gh pr checks --repo "$REPO" --watch --interval 10 >/dev/null || { echo "E_CI: 检查未通过" >&2; exit 1; }
gh pr merge --repo "$REPO" --squash >/dev/null || { echo "E_MERGE: 合并失败" >&2; exit 1; }
git -C "$WT" push -q origin --delete "$BR" 2>/dev/null || true

git fetch -q origin main
SHA="$(git rev-parse origin/main)"
git -C "$WT" tag -a "v$NEW" "$SHA" -m "v$NEW"
git -C "$WT" push origin "v$NEW" || { echo "E_TAG: tag 推送失败" >&2; exit 1; }
gh release create "v$NEW" --repo "$REPO" --generate-notes --title "v$NEW"
echo "released v$NEW"
echo "npm publish: 由 publish.yml 在 release published 时用 OIDC 完成（需 npmjs 侧配好 Trusted Publisher）"
