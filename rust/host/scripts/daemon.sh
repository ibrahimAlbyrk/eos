#!/bin/bash
# Starts or stops the ISOLATED Node daemon the dev proxy talks to: its own copy of the data
# folder, its own ports, its own HOME, no launchd. CLAUDE_CONFIG_DIR points at an empty folder, so a
# `claude` child, should one ever start, can neither read nor write the real ~/.claude; the
# shell's dev proxy refuses every write that could start one in the first place.
#
#   usage: daemon.sh start|stop|status
#   Which data folder and ports: see dev-env.sh.
set -u
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$HOST_DIR/../.." && pwd)"
source "$HOST_DIR/scripts/dev-env.sh"
HOME_COPY="$EOS_DEV_HOME"; OUT="$EOS_DEV_OUT"
PORT="$EOS_DEV_PORT"; RAW_PORT="$EOS_DEV_RAW_PORT"
mkdir -p "$OUT"
up() { curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
case "${1:-start}" in
  status) up && echo "up" || echo "down" ;;
  stop)
    [ -f "$OUT/daemon.pid" ] && kill -TERM "$(cat "$OUT/daemon.pid")" 2>/dev/null
    rm -f "$OUT/daemon.pid"
    for _ in $(seq 1 40); do up || break; sleep 0.25; done
    up && echo "still up" || echo "stopped" ;;
  start)
    up && { echo "already up"; exit 0; }
    [ -d "$HOME_COPY" ] || { echo "no data copy at $HOME_COPY (cp -R $EOS_DEV_DATA/home $HOME_COPY)" >&2; exit 1; }
    [ -d "$REPO/manager/node_modules" ] || { echo "the daemon has no node modules: run rust/host/scripts/setup.sh" >&2; exit 1; }
    mkdir -p "$HOME_COPY/claude-config"
    [ -z "$(ls -A "$HOME_COPY/claude-config")" ] || { echo "$HOME_COPY/claude-config must stay empty" >&2; exit 1; }
    cd "$REPO"
    # Its own HOME and temp folder too: nothing it or a child of it does by default path
    # can land in the real ones.
    mkdir -p "$OUT/daemon-home" "$OUT/daemon-tmp"
    nohup env -i PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$OUT/daemon-home" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
      TMPDIR="$OUT/daemon-tmp" LANG=en_US.UTF-8 EOS_HOME="$HOME_COPY" EOS_PORT=$PORT EOS_RAW_PORT=$RAW_PORT \
      EOS_WORKER_PORT_START="${EOS_DEV_WORKER_PORTS%-*}" EOS_WORKER_PORT_END="${EOS_DEV_WORKER_PORTS#*-}" CLAUDE_CONFIG_DIR="$HOME_COPY/claude-config" \
      node --max-old-space-size=1024 --no-warnings --experimental-strip-types manager/daemon.ts >> "$OUT/daemon.log" 2>&1 &
    echo $! > "$OUT/daemon.pid"
    for _ in $(seq 1 80); do up && break; sleep 0.25; done
    up && echo "up" || { echo "the daemon did not come up; see $OUT/daemon.log" >&2; exit 1; } ;;
esac
