#!/bin/bash
# Development run: the debug bundle against the isolated Node daemon (dev proxy).
#
#   dev.sh            build, start the daemon if needed, open the app
#   dev.sh quiet      the same without taking the focus (no Dock icon, no sound)
#   dev.sh status     the running app's state as JSON
#   dev.sh stop       quit the app and stop the daemon
#
# The app runs on private test data only (see launch.sh); the dev proxy refuses every write
# that could start an agent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$("$HERE/bundle.sh" debug 2>/dev/null | tail -1)" || { "$HERE/bundle.sh" debug; exit 1; }
case "${1:-run}" in
  status) "$HERE/ctl.sh" "$APP" --status ;;
  stop) "$HERE/ctl.sh" "$APP" --quit || true; "$HERE/daemon.sh" stop ;;
  quiet) "$HERE/daemon.sh" start && "$HERE/launch.sh" "$APP" --quiet ;;
  run) "$HERE/daemon.sh" start && "$HERE/launch.sh" "$APP" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
