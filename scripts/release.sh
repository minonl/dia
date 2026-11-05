#!/usr/bin/env bash
# release.sh —— 打版本 + GitHub Release（dia 是私有仓，默认不发 npm）
#
# 用法：scripts/release.sh <patch|minor|major|x.y.z> [--dry-run]
# 前置：main 干净且与 origin 同步；CI 通过由调用方保证（见 scripts/pr-merge.sh）
set -uo pipefail
BUMP="${1:-}"; DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
case "$BUMP" in patch|minor|major|[0-9]*.[0-9]*.[0-9]*) ;; *) echo "usage: $0 <patch|minor|major|x.y.z> [--dry-run]" >&2; exit 2 ;; esac

[ -z "$(git status --porcelain)" ] || { echo "E_DIRTY: 工作区不干净" >&2; exit 1; }
BR="$(git branch --show-current)"; [ "$BR" = main ] || { echo "E_BRANCH: 必须在 main（当前 $BR）" >&2; exit 1; }
git fetch -q origin && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "E_SYNC: main 与 origin 不一致" >&2; exit 1; }

OLD="$(node -p "require('./package.json').version")"
NEW="$(node -e '
const [a,b,c]=require("./package.json").version.split(".").map(Number);
const b2=process.argv[1];
const out=b2==="patch"?[a,b,c+1]:b2==="minor"?[a,b+1,0]:b2==="major"?[a+1,0,0]:b2.split(".").map(Number);
console.log(out.join("."));' "$BUMP")"
REPO="${REPO:-minonl/dia}"
echo "bump: $OLD -> $NEW"
if [ "$DRY" = 1 ]; then echo "dry-run: 将改 package.json、提交、打 tag v$NEW、推 origin、gh release create"; exit 0; fi

node -e 'const fs=require("fs");const p=require("./package.json");p.version=process.argv[1];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' "$NEW"
# main 已开 branch protection（enforce_admins）：版本提交走 PR，不直推
BR="chore/release-v$NEW"
git checkout -q -b "$BR"
git add package.json && git commit -q -m "chore(release): v$NEW"
git push -q -u origin "$BR"
gh pr create --repo "$REPO" --head "$BR" --base main --title "chore(release): v$NEW" --body "版本号 v$NEW；合后打 tag 并触发 publish。" >/dev/null
gh pr checks --repo "$REPO" --watch --interval 10 >/dev/null
gh pr merge --repo "$REPO" --squash --delete-branch >/dev/null
git checkout -q main && git pull --ff-only -q
git tag -a "v$NEW" -m "v$NEW"
git push origin "v$NEW"
gh release create "v$NEW" --repo "$REPO" --generate-notes --title "v$NEW"
echo "released v$NEW"
# npm 发布由 .github/workflows/publish.yml 在 release published 时用 OIDC 完成（仓库不放 token）
echo "npm publish: 由 publish.yml 触发（需先在 npmjs 配好 Trusted Publisher）"
