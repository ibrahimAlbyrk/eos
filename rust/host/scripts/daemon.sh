#!/bin/bash
# Starts or stops the ISOLATED Node daemon the dev proxy talks to: its own copy of the data
# folder, its own ports, no launchd. CLAUDE_CONFIG_DIR points at an empty folder, so a
# `claude` child, should one ever start, can neither read nor write the real ~/.claude; the
# shell's dev proxy refuses every write that could start one in the first place.
#
#   usage: daemon.sh start|stop|status
#   EOS_DEV_DATA   private data root (default: ../eos-rs-data next to the worktrees)
set -u
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$HOST_DIR/../.." && pwd)"
DATA="${EOS_DEV_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
HOME_COPY="$DATA/run-shell"; OUT="$DATA/shell-out"
PORT=7490; RAW_PORT=7491
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
    [ -d "$HOME_COPY" ] || { echo "no data copy at $HOME_COPY (cp -R $DATA/home $HOME_COPY)" >&2; exit 1; }
    mkdir -p "$HOME_COPY/claude-config"
    [ -z "$(ls -A "$HOME_COPY/claude-config")" ] || { echo "$HOME_COPY/claude-config must stay empty" >&2; exit 1; }
    cd "$REPO"
    nohup env -i PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
      TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 EOS_HOME="$HOME_COPY" EOS_PORT=$PORT EOS_RAW_PORT=$RAW_PORT \
      EOS_WORKER_PORT_START=7600 EOS_WORKER_PORT_END=7650 CLAUDE_CONFIG_DIR="$HOME_COPY/claude-config" \
      node --max-old-space-size=1024 --no-warnings --experimental-strip-types manager/daemon.ts >> "$OUT/daemon.log" 2>&1 &
    echo $! > "$OUT/daemon.pid"
    for _ in $(seq 1 80); do up && break; sleep 0.25; done
    up && echo "up" || { echo "the daemon did not come up; see $OUT/daemon.log" >&2; exit 1; } ;;
esac
