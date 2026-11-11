#!/bin/bash
# Opens a bundled Eos.app against the isolated Node daemon (dev proxy) on private test data.
# Shared by dev.sh, try.sh and the smoke run.
#
#   usage: launch.sh <path to Eos.app> [--quiet]
#   --quiet   no focus, no Dock icon, audio muted: for automated runs.
#
#   EOS_DEV_DATA          private data root (default: eos-rs-data next to the worktrees)
#   EOS_HOME              the Rust core's data folder (default: the isolated daemon's)
#   EOS_LOG               what the app logs to shell-out/app.err (default: which side served
#                         each request, at debug level)
#   EOS_SHELL_DATA        the shell's data folder (default: $EOS_DEV_DATA/shell-out/data)
#   EOS_ELECTRON_PROFILE  an Electron profile COPY to carry localStorage over from, or `none`
#   EOS_DEV_SCRIPT[_OUT]  steps to run on test views (see eos/src/dev/script.rs)
set -euo pipefail
APP="$1"; QUIET="${2:-}"
DATA="${EOS_DEV_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
OUT="$DATA/shell-out"
SHELL_DATA="${EOS_SHELL_DATA:-$OUT/data}"
mkdir -p "$OUT" "$SHELL_DATA"
ENVS=(--env "EOS_SHELL_DATA=$SHELL_DATA"
      --env "EOS_DEV_DAEMON_URL=http://127.0.0.1:7490" --env "EOS_DEV_DAEMON_RAW_URL=http://127.0.0.1:7491"
      --env "EOS_DEV_DAEMON_HOME=$DATA/run-shell"
      # The Rust core opens the same isolated data folder as the daemon: one ui-token, one
      # set of data, whichever side answers a route.
      --env "EOS_HOME=${EOS_HOME:-$DATA/run-shell}" --env "EOS_LOG=${EOS_LOG:-warn,eos::bridge=debug}"
      # Test data: never the real Electron profile, never the login keychain.
      --env "EOS_ELECTRON_PROFILE=${EOS_ELECTRON_PROFILE:-none}" --env "EOS_SHELL_MOCK_KEYCHAIN=1")
[ -n "${EOS_SHELL_TRACE:-}" ] && ENVS+=(--env "EOS_SHELL_TRACE=1")
[ -n "${EOS_DEV_RUST_STREAM:-}" ] && ENVS+=(--env "EOS_DEV_RUST_STREAM=1")
[ -n "${EOS_SHELL_NETLOG:-}" ] && ENVS+=(--env "EOS_SHELL_NETLOG=$EOS_SHELL_NETLOG")
[ -n "${EOS_DEV_SCRIPT:-}" ] && ENVS+=(--env "EOS_DEV_SCRIPT=$EOS_DEV_SCRIPT" --env "EOS_DEV_SCRIPT_OUT=$EOS_DEV_SCRIPT_OUT")
if [ "$QUIET" = "--quiet" ]; then
  ENVS+=(--env "EOS_SHELL_QUIET=1" --env "TAURI_CEF_NO_ACTIVATE=1")
  # -g: do not bring the app forward. -n: this bundle, even if another copy is registered.
  open -g -n "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}"
else
  open -n "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}"
fi
