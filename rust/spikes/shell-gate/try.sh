#!/bin/bash
# For the owner: the things only a person can check. Starts the isolated daemon if needed
# and opens the gate app in the foreground (it takes focus, like a normal app).
#   try.sh            the dashboard: drag the window by the top strip, resize, use the side-panel browser
#   try.sh claude     also opens https://claude.ai/login in a no-bridge view with its own profile: sign in there
#   try.sh cookies    after signing in: prints the cookie NAMES of that view (look for sessionKey)
#   try.sh stop       quits the app and stops the isolated daemon
# The app must exist: ./bundle.sh release   (optionally ./sign.sh <app>, then GATE_APP=<signed app>)
set -u
G="$(cd "$(dirname "$0")" && pwd)"; cd "$G"
case "${1:-}" in
  stop) ./ctl.py quit >/dev/null 2>&1; ./daemon.sh stop; exit 0 ;;
  cookies) ./ctl.py view.cookies view=claude url=https://claude.ai/; exit 0 ;;
esac
curl -s -m 1 http://127.0.0.1:7490/health >/dev/null || ./daemon.sh start
GATE_FOREGROUND=1 GATE_MAX_SECS=3600 ./run.sh release || exit 1
if [ "${1:-}" = "claude" ]; then
  ./ctl.py view.open view=claude url=https://claude.ai/login profile=claude-owner noBridge=true x=320 y=64 w=900 h=720
fi
