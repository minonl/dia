#!/usr/bin/env bash
# dia-job 路径策略（项目无关；不依赖 yan-agent/platform.sh）
# 目标：判断注册命令的目标是否稳定；worktree/ephemeral 必须拒绝。
# 输出：dia_job_cmd_path_class 设置 YP_CLASS / YP_CMD_TARGET / YP_MAIN / YP_REASON（兼容旧调用方）。

dia_job_data_root() {
  printf '%s' "${DIA_JOB_ROOT:-${YAN_DATA_ROOT:-$HOME/.yan-agent}}"
}

# 主 checkout：git-common-dir 的父目录；裸仓/非仓明确失败。
dia_job_main_checkout_of() {
  local d="${1:-}" common abs
  if [ -z "$d" ]; then printf 'dia_job_main_checkout_of: 缺少参数（目录）\n' >&2; return 2; fi
  [ -d "$d" ] || { printf 'dia_job_main_checkout_of: 目录不存在：%s\n' "$d" >&2; return 1; }
  if [ "$(git -C "$d" rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]; then
    printf 'dia_job_main_checkout_of: 不是 git 工作区（裸仓或非仓）：%s\n' "$d" >&2
    return 1
  fi
  common="$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
    printf 'dia_job_main_checkout_of: 无法解析 git-common-dir：%s\n' "$d" >&2; return 1; }
  [ -n "$common" ] || { printf 'dia_job_main_checkout_of: git-common-dir 为空：%s\n' "$d" >&2; return 1; }
  if [ "${common#/}" = "$common" ]; then
    common="$(cd "$d" && cd "$common" 2>/dev/null && pwd -P)" || {
      printf 'dia_job_main_checkout_of: 无法定位 git-common-dir（旧版 git 回退失败）：%s\n' "$d" >&2; return 1; }
  fi
  case "$(basename "$common")" in
    .git) : ;;
    *) printf 'dia_job_main_checkout_of: 意外的 git-common-dir：%s\n' "$common" >&2; return 1 ;;
  esac
  abs="$(cd "$(dirname "$common")" 2>/dev/null && pwd -P)" || {
    printf 'dia_job_main_checkout_of: 无法规范化路径：%s\n' "$common" >&2; return 1; }
  printf '%s' "$abs"
}

# 提取注册命令中的首个绝对路径；对命令替换只识别全局稳定入口目录。
dia_job_extract_target() {
  local cmd="${1:-}" entry refhit
  [ -n "$cmd" ] || return 0
  entry="${DIA_JOB_ENTRY_DIR:-$(dia_job_data_root)/bin}"
  case "$cmd" in
    *'$('*)
      # 只提取引号内、位于稳定入口目录下的路径；不执行命令替换
      refhit="$(printf '%s' "$cmd" | grep -oE "'[^']+'" | tr -d "'" | while IFS= read -r x; do
        case "$x" in "$entry"/*) printf '%s' "$x"; break ;; esac
      done)"
      [ -n "$refhit" ] && printf '%s' "$refhit"
      return 0 ;;
  esac
  case "$cmd" in
    *'$('*|*'`'*|*'>'*|*'<'*|*';'*|*'|'*|*'&'*) return 0 ;;
  esac
  bash -c '
    c="$1"
    bash -n <<<"$c" 2>/dev/null || exit 0
    eval "set -- $c" 2>/dev/null || exit 0
    for a in "$@"; do case "$a" in /*) printf "%s" "$a"; break;; esac; done
  ' _ "$cmd" 2>/dev/null
}

dia_job_path_stability() {
  local p="${1:-}"
  YP_CLASS="unknown"; YP_MAIN=""; YP_REASON=""
  if [ -z "$p" ]; then YP_CLASS="none"; YP_REASON="无路径（如 adopt 的任务无 cmd）"; return 0; fi
  case "$p" in
    *-worktree--*|*/.worktrees/*)
      YP_CLASS="ephemeral"; YP_REASON="指向 worktree（临时目录）—— 清理后必悬空"; return 0 ;;
  esac
  case "$p" in /*) : ;; *) YP_CLASS="unknown"; YP_REASON="相对路径，无法判定稳定性"; return 0 ;; esac
  case "$p" in
    "${DIA_JOB_ENTRY_DIR:-$(dia_job_data_root)/bin}"/*)
      YP_CLASS="ref-entry"; YP_REASON="全局稳定入口（DIA_JOB_ROOT/bin）"; return 0 ;;
  esac
  local dir="$p"
  [ -d "$dir" ] || dir="$(dirname "$p")"
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ ! -d "$dir" ]; do dir="$(dirname "$dir")"; done
  local p_real; p_real="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)/$(basename "$p")"
  [ -n "$p_real" ] || p_real="$p"
  local wt main_wt
  main_wt="$(dia_job_main_checkout_of "$dir" 2>/dev/null || true)"
  if [ -n "$main_wt" ]; then
    while IFS= read -r wt; do
      [ -n "$wt" ] || continue
      [ "$wt" = "$main_wt" ] && continue
      case "$p_real" in
        "$wt"/*|"$wt")
          YP_CLASS="ephemeral"; YP_MAIN="$main_wt"
          YP_REASON="命中 git worktree 清单中的非主 checkout（${wt}）—— 清理后必悬空"; return 0 ;;
      esac
    done < <(git -C "$dir" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  fi
  if [ -n "$main_wt" ]; then
    case "$p_real" in "$main_wt"/*) YP_REASON="位于主 checkout $main_wt 之下" ;; *) YP_REASON="同一仓（主 checkout ${main_wt}）" ;; esac
    YP_CLASS="main-checkout"; YP_MAIN="$main_wt"; return 0
  fi
  YP_CLASS="non-repo-abs"; YP_REASON="绝对路径，但不在任何 git 仓内"; return 0
}

dia_job_cmd_path_class() {
  YP_CMD_TARGET="$(dia_job_extract_target "${1:-}")"
  if [ -z "${1:-}" ]; then YP_CLASS="none"; YP_REASON="无 cmd（adopt 的任务）"; return 0; fi
  if [ -z "$YP_CMD_TARGET" ]; then YP_CLASS="unknown"; YP_REASON="cmd 中未提取到绝对路径"; return 0; fi
  dia_job_path_stability "$YP_CMD_TARGET"
}
