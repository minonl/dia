#!/bin/sh
# fake tmux：FAKE_TMUX_SCENARIO=idle|busy|no-readback
# 记录每次调用，便于断言「忙时不注入」
[ -n "$FAKE_TMUX_LOG" ] && echo "$*" >> "$FAKE_TMUX_LOG"
cmd="$1"; shift
case "$cmd" in
  display-message)
    # pushPointer 先问 pane_current_path；isBusy 问 pane_in_mode
    case "$*" in
      *pane_in_mode*) echo 0 ;;
      *pane_current_path*) echo "${FAKE_TMUX_CWD:-/tmp}" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-opencode}" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    case "${FAKE_TMUX_SCENARIO:-idle}" in
      busy) printf 'working... esc to interrupt\n' ;;
      no-readback) printf 'prompt>\n' ;;
      *) id="$(sed -n 's/.*dia-\(.*\)-n[0-9a-z]*.*/\1/p' "${FAKE_TMUX_LOG:-/dev/null}" 2>/dev/null | tail -1)"; printf '[dia-msg %s] fake\n' "${id:-m-x}" ;;
    esac ;;
  load-buffer|paste-buffer|send-keys|delete-buffer) exit 0 ;;
  *) exit 0 ;;
esac
