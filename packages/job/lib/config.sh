#!/usr/bin/env bash
# dia-job 全局配置：环境变量优先；否则读 $DIA_JOB_CONFIG 或 ~/.config/dia-job/config
# 文件格式：纯 KEY=value；只接受 DIA_JOB_* 键；不 source、不执行文件内容。
dia_job_load_config() {
  local f="${DIA_JOB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dia-job/config}"
  [ -f "$f" ] || return 0
  local k v
  while IFS='=' read -r k v || [ -n "${k:-}" ]; do
    k="${k%%[[:space:]]*}"
    case "$k" in DIA_JOB_*) ;; *) continue ;; esac
    v="${v%$'\r'}"
    case "$v" in
      \"*\") v="${v#\"}"; v="${v%\"}" ;;
      \'*\') v="${v#\'}"; v="${v%\'}" ;;
    esac
    if [ -z "${!k:-}" ]; then export "$k=$v"; fi
  done < "$f"
}
