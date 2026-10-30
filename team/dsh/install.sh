#!/usr/bin/env bash
# 安装/更新 dabo 团队的 dsh 角色 profile（planner/builder/verifier/redteam）
set -euo pipefail
cd "$(dirname "$0")"
for role in planner builder verifier redteam; do
  dest="$HOME/.dsh/profiles/dabo-$role"
  rm -rf "$dest"
  cp -R "$role" "$dest"
  echo "installed $dest"
done
