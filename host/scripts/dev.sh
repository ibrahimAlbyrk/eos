#!/bin/bash
# Development run: the debug bundle (with the dev guard) on private test data.
#
#   dev.sh            build, open the app
#   dev.sh quiet      the same without taking the focus (no Dock icon, no sound)
#   dev.sh status     the running app's state as JSON
#   dev.sh stop       quit the app
#
# The app runs on a copy of real data (see launch.sh); the dev guard refuses whatever could
# start an agent unless EOS_DEV_ALLOW_AGENTS=1.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$("$HERE/bundle.sh" debug 2>/dev/null | tail -1)" || { "$HERE/bundle.sh" debug; exit 1; }
case "${1:-run}" in
  status) "$HERE/ctl.sh" "$APP" --status ;;
  stop) "$HERE/ctl.sh" "$APP" --quit ;;
  quiet) "$HERE/launch.sh" "$APP" --quiet ;;
  run) "$HERE/launch.sh" "$APP" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
