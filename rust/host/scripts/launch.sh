#!/bin/bash
# Opens a bundled Eos.app against the isolated Node daemon (dev proxy) on private test data.
# Shared by dev.sh, try.sh and the smoke run.
#
#   usage: launch.sh <path to Eos.app> [--quiet]
#   --quiet   no focus, no Dock icon, audio muted: for automated runs.
#
#   Which data folder and daemon: see dev-env.sh.
#   EOS_HOME              the Rust core's data folder (default: the isolated daemon's); set it
#                         empty to run without the Rust core (the shell and the proxy alone)
#   EOS_LOG               what the app logs to shell-out/app.err (default: which side served
#                         each request, at debug level)
#   EOS_SHELL_DATA        the shell's data folder (default: $EOS_DEV_OUT/data)
#   EOS_ELECTRON_PROFILE  an Electron profile COPY to carry localStorage over from, or `none`
#   EOS_DEV_SCRIPT[_OUT]  steps to run on test views (see eos/src/dev/script.rs)
set -euo pipefail
APP="$1"; QUIET="${2:-}"
source "$(dirname "$0")/dev-env.sh"
OUT="$EOS_DEV_OUT"
SHELL_DATA="${EOS_SHELL_DATA:-$OUT/data}"
mkdir -p "$OUT" "$SHELL_DATA"
ENVS=(--env "EOS_SHELL_DATA=$SHELL_DATA"
      --env "EOS_DEV_DAEMON_URL=http://127.0.0.1:$EOS_DEV_PORT" --env "EOS_DEV_DAEMON_RAW_URL=http://127.0.0.1:$EOS_DEV_RAW_PORT"
      --env "EOS_DEV_DAEMON_HOME=$EOS_DEV_HOME"
      # The Rust core opens the same isolated data folder as the daemon: one ui-token, one
      # set of data, whichever side answers a route.
      --env "EOS_HOME=${EOS_HOME-$EOS_DEV_HOME}" --env "EOS_LOG=${EOS_LOG:-warn,eos::bridge=debug}"
      # Whatever the core starts reads and writes Claude Code's files here, never the real
      # ~/.claude. daemon.sh checks that the folder stays empty: nothing should start at all.
      --env "CLAUDE_CONFIG_DIR=$EOS_DEV_HOME/claude-config"
      # Test data: never the real Electron profile, never the login keychain.
      --env "EOS_ELECTRON_PROFILE=${EOS_ELECTRON_PROFILE:-none}" --env "EOS_SHELL_MOCK_KEYCHAIN=1")
[ -n "${EOS_SHELL_TRACE:-}" ] && ENVS+=(--env "EOS_SHELL_TRACE=1")
[ -n "${EOS_SHELL_NETWORK_IN_PROCESS:-}" ] && ENVS+=(--env "EOS_SHELL_NETWORK_IN_PROCESS=1")
[ -n "${EOS_SHELL_PAINT_WHEN_COVERED:-}" ] && ENVS+=(--env "EOS_SHELL_PAINT_WHEN_COVERED=1")
[ -n "${EOS_DEV_RUST_STREAM:-}" ] && ENVS+=(--env "EOS_DEV_RUST_STREAM=1")
[ "${EOS_DEV_ALLOW_AGENTS:-}" = "1" ] && ENVS+=(--env "EOS_DEV_ALLOW_AGENTS=1")
[ -n "${EOS_SHELL_NETLOG:-}" ] && ENVS+=(--env "EOS_SHELL_NETLOG=$EOS_SHELL_NETLOG")
[ -n "${EOS_DEV_SCRIPT:-}" ] && ENVS+=(--env "EOS_DEV_SCRIPT=$EOS_DEV_SCRIPT" --env "EOS_DEV_SCRIPT_OUT=$EOS_DEV_SCRIPT_OUT")
[ -n "${EOS_DEV_ARTIFACT_ORIGIN:-}" ] && ENVS+=(--env "EOS_DEV_ARTIFACT_ORIGIN=$EOS_DEV_ARTIFACT_ORIGIN")
if [ "$QUIET" = "--quiet" ]; then
  ENVS+=(--env "EOS_SHELL_QUIET=1" --env "TAURI_CEF_NO_ACTIVATE=1")
  # -g: do not bring the app forward. -n: this bundle, even if another copy is registered.
  open -g -n "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}"
else
  open -n "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}"
fi
