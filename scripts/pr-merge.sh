#!/usr/bin/env bash
# pr-merge.sh —— 只在 CI 全绿时合并（GitHub 免费私有仓不能开 branch protection，用脚本兜住）
#
# 用法：scripts/pr-merge.sh <pr-or-url> [--repo owner/name] [--dry-run]
# 退出码：0 合并成功；1 有 pending/failing；2 用法错误；3 合并失败
set -uo pipefail

REPO="${REPO:-minonl/dia}"
DRY=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) args+=("$1"); shift ;;
  esac
done
N="${args[0]:-}"
[ -n "$N" ] || { echo "usage: $0 <pr-or-url> [--repo owner/name] [--dry-run]" >&2; exit 2; }

json="$(gh pr checks "$N" --repo "$REPO" --json name,bucket,state 2>/dev/null)" || { echo "E_CI: 取不到检查结果（PR 不存在或无权限）" >&2; exit 1; }
bad="$(printf '%s' "$json" | python3 -c '
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
bad=[x.get("name") or "?" for x in rows if str(x.get("bucket") or "").lower() not in ("pass","skipping")]
print(",".join(bad))
')"
if [ -n "$bad" ]; then
  echo "E_CI: 有未通过/未完成的检查：$bad" >&2
  exit 1
fi
if [ "$DRY" = 1 ]; then
  echo "dry-run: checks ok，将合并 $(printf '%s' "$N" | sed 's#.*/pull/##') in $REPO"
  exit 0
fi
gh pr merge "$N" --repo "$REPO" --squash --delete-branch || { echo "E_MERGE: 合并失败" >&2; exit 3; }
