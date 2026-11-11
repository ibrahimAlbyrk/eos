#!/usr/bin/env bash
# Runs today's Node daemon in isolation, for recording and replaying wire fixtures:
# its own data folder and ports, no launchd, a clean environment. It never touches
# ~/.eos or a running Eos.
#
#   wire-daemon.sh start <home>   boots, waits until healthy, prints the pid
#   wire-daemon.sh stop  <home>   stops the daemon started on <home>
#
# EOS_WIRE_PORT / EOS_WIRE_RAW_PORT  ports (default 7500 / 7501)
# EOS_WIRE_USER_HOME                 the daemon's $HOME (default: <home>/../user), so it reads
#                                    nothing of the real user's ~/.claude, commands or git config.
#                                    CLAUDE_CONFIG_DIR points inside it too, and both reach every
#                                    child: a `claude` the daemon might start can only write there,
#                                    never to the real ~/.claude/projects.
# EOS_WIRE_ROUTES_OUT                also write the registered route table there
set -euo pipefail

cmd="${1:?start|stop}"
home="${2:?data folder}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
port="${EOS_WIRE_PORT:-7500}"
raw_port="${EOS_WIRE_RAW_PORT:-7501}"
user_home="${EOS_WIRE_USER_HOME:-$(dirname "$home")/user}"
pidfile="$home/wire-daemon.pid"

healthy() {
  curl -s -o /dev/null --max-time 1 --unix-socket "$home/daemon.sock" http://x/health
}

case "$cmd" in
  start)
    if [ "${#home}" -gt 90 ]; then
      echo "data folder path too long for a unix socket (max 90): $home" >&2
      exit 1
    fi
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/health"; then
      echo "port $port is already serving; stop that daemon first" >&2
      exit 1
    fi
    mkdir -p "$home/logs" "$user_home/.claude" "$user_home/tmp"
    probe=()
    if [ -n "${EOS_WIRE_ROUTES_OUT:-}" ]; then
      probe=(--import "$repo/rust/tools/wire-recorder/node/route-probe.mjs")
    fi
    # A clean environment: nothing of the caller's Eos session leaks in. The phone
    # relay and hosting for paired computers default to on, so they are forced off:
    # a recording daemon must not dial out or listen beyond loopback. UTC and a
    # fixed locale, because some answers print times and sort names.
    env -i PATH="$PATH" HOME="$user_home" CLAUDE_CONFIG_DIR="$user_home/.claude" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/sh}" \
      TMPDIR="$user_home/tmp" LANG="en_US.UTF-8" TZ=UTC \
      EOS_HOME="$home" EOS_PORT="$port" EOS_RAW_PORT="$raw_port" EOS_REPO_ROOT="$repo" \
      EOS_WORKER_PORT_START=7520 EOS_WORKER_PORT_END=7599 \
      EOS_REMOTE_ENABLED=0 EOS_PEER_ENABLED=0 \
      EOS_WIRE_REPO="$repo" EOS_WIRE_ROUTES_OUT="${EOS_WIRE_ROUTES_OUT:-}" \
      nohup node --max-old-space-size=1024 --no-warnings --experimental-strip-types \
      ${probe[@]+"${probe[@]}"} "$repo/manager/daemon.ts" >>"$home/logs/wire-stdout.log" 2>&1 &
    pid=$!
    echo "$pid" >"$pidfile"
    for _ in $(seq 1 600); do
      if healthy; then
        echo "$pid"
        exit 0
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "daemon exited during boot; see $home/logs/wire-stdout.log" >&2
        exit 1
      fi
      sleep 0.1
    done
    echo "daemon not healthy after 60s" >&2
    kill "$pid" 2>/dev/null || true
    exit 1
    ;;
  stop)
    [ -f "$pidfile" ] || exit 0
    pid="$(cat "$pidfile")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    ;;
  *)
    echo "usage: wire-daemon.sh start|stop <home>" >&2
    exit 1
    ;;
esac
