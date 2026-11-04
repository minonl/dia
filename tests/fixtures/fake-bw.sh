#!/bin/sh
case "$1" in
  status) echo '{"status":"unlocked","serverUrl":null}' ;;
  unlock) echo "SESSION-TOKEN" ;;
  lock) echo '{}' ;;
  get)
    if [ "$2" = "password" ]; then
      case "$3" in missing) exit 1 ;; *) echo "secret-$3" ;; esac
    fi ;;
  *) exit 2 ;;
esac
