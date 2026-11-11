#!/bin/bash
# Starts / stops the ISOLATED Node daemon the gate app talks to (own home, own ports, no
# launchd). CLAUDE_CONFIG_DIR points at an empty folder so a `claude` child, should one
# ever start, cannot read or write anything under the real ~/.claude.
# usage: daemon.sh start|stop
set -u
G="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$G/../../.." && pwd)"
DATA="${GATE_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
H="$DATA/run-shell"; O="$DATA/shell-gate-out"; mkdir -p "$O" "$H/claude-config"
case "${1:-start}" in
  stop) [ -f "$O/daemon.pid" ] && kill -TERM "$(cat "$O/daemon.pid")" 2>/dev/null; rm -f "$O/daemon.pid" ;;
  start)
    cd "$REPO"
    nohup env -i PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
      TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 EOS_HOME="$H" EOS_PORT=7490 EOS_RAW_PORT=7491 \
      EOS_WORKER_PORT_START=7600 EOS_WORKER_PORT_END=7650 CLAUDE_CONFIG_DIR="$H/claude-config" \
      node --max-old-space-size=1024 --no-warnings --experimental-strip-types manager/daemon.ts >> "$O/daemon.log" 2>&1 &
    echo $! > "$O/daemon.pid"
    for _ in $(seq 1 60); do curl -s -m 1 http://127.0.0.1:7490/health >/dev/null && break; sleep 0.25; done
    curl -s -m 2 http://127.0.0.1:7490/health | head -c 80; echo ;;
esac
