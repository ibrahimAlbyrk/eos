#!/bin/bash
# Opens a dev-run Eos.app (bundle.sh test or debug) on private test data. Shared by dev.sh,
# try.sh and the test drivers. A bundle without the dev guard (bundle.sh release) is refused:
# on a copy of real data it could start agents.
#
#   usage: launch.sh <path to Eos.app> [--quiet]
#   --quiet   no focus, no Dock icon, audio muted: for automated runs.
#
#   Which data folder: see dev-env.sh. A missing copy is made from $EOS_DEV_DATA/home.
#   EOS_HOME              the Rust core's data folder (default: $EOS_DEV_HOME); set it empty
#                         to run the shell alone, without the core
#   EOS_LOG               what the app logs to $EOS_DEV_OUT/app.err (default: what became of
#                         each request, at debug level)
#   EOS_SHELL_DATA        the shell's data folder (default: $EOS_DEV_OUT/data)
#   EOS_ELECTRON_PROFILE  an Electron profile COPY to carry localStorage over from, or `none`
#   EOS_DEV_SCRIPT[_OUT]  steps to run on test views (see eos/src/dev/script.rs)
set -euo pipefail
APP="$1"; QUIET="${2:-}"
source "$(dirname "$0")/dev-env.sh"
grep -q "refused in a dev run" "$APP/Contents/MacOS/Eos" \
  || { echo "$APP has no dev guard: build it with bundle.sh test (or debug)" >&2; exit 1; }
OUT="$EOS_DEV_OUT"
SHELL_DATA="${EOS_SHELL_DATA:-$OUT/data}"
mkdir -p "$OUT" "$SHELL_DATA"
if [ ! -d "$EOS_DEV_HOME" ]; then
  [ -d "$EOS_DEV_DATA/home" ] || { echo "no data to copy at $EOS_DEV_DATA/home" >&2; exit 1; }
  echo "making the data copy at $EOS_DEV_HOME" >&2
  cp -R "$EOS_DEV_DATA/home" "$EOS_DEV_HOME" && chmod -R go-rwx "$EOS_DEV_HOME"
fi
# Whatever the core starts reads and writes Claude Code's files here, never the real
# ~/.claude. Unless the run allows agents nothing should start at all: the folder stays empty.
mkdir -p "$EOS_DEV_HOME/claude-config"
if [ "${EOS_DEV_ALLOW_AGENTS:-}" != "1" ] && [ -n "$(ls -A "$EOS_DEV_HOME/claude-config")" ]; then
  echo "$EOS_DEV_HOME/claude-config must stay empty" >&2
  exit 1
fi
ENVS=(--env "EOS_SHELL_DATA=$SHELL_DATA"
      --env "EOS_HOME=${EOS_HOME-$EOS_DEV_HOME}" --env "EOS_LOG=${EOS_LOG:-warn,eos::bridge=debug}"
      --env "CLAUDE_CONFIG_DIR=$EOS_DEV_HOME/claude-config"
      # Test data: never the real Electron profile, never the login keychain.
      --env "EOS_ELECTRON_PROFILE=${EOS_ELECTRON_PROFILE:-none}" --env "EOS_SHELL_MOCK_KEYCHAIN=1")
[ -n "${EOS_SHELL_TRACE:-}" ] && ENVS+=(--env "EOS_SHELL_TRACE=1")
[ -n "${EOS_SHELL_NETWORK_IN_PROCESS:-}" ] && ENVS+=(--env "EOS_SHELL_NETWORK_IN_PROCESS=1")
[ -n "${EOS_SHELL_PAINT_WHEN_COVERED:-}" ] && ENVS+=(--env "EOS_SHELL_PAINT_WHEN_COVERED=1")
[ -n "${EOS_SHELL_PROBE:-}" ] && ENVS+=(--env "EOS_SHELL_PROBE=1")
[ "${EOS_DEV_ALLOW_AGENTS:-}" = "1" ] && ENVS+=(--env "EOS_DEV_ALLOW_AGENTS=1")
[ -n "${EOS_SHELL_NETLOG:-}" ] && ENVS+=(--env "EOS_SHELL_NETLOG=$EOS_SHELL_NETLOG")
[ -n "${EOS_DEV_SCRIPT:-}" ] && ENVS+=(--env "EOS_DEV_SCRIPT=$EOS_DEV_SCRIPT" --env "EOS_DEV_SCRIPT_OUT=$EOS_DEV_SCRIPT_OUT")
[ -n "${EOS_DEV_SCRIPT_FOLLOW:-}" ] && ENVS+=(--env "EOS_DEV_SCRIPT_FOLLOW=1")
[ -n "${EOS_DEV_ARTIFACT_ORIGIN:-}" ] && ENVS+=(--env "EOS_DEV_ARTIFACT_ORIGIN=$EOS_DEV_ARTIFACT_ORIGIN")
if [ "$QUIET" = "--quiet" ]; then
  ENVS+=(--env "EOS_SHELL_QUIET=1" --env "TAURI_CEF_NO_ACTIVATE=1")
  # -g: do not bring the app forward. -n: this bundle, even if another copy is registered.
  open -g -n "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}"
else
  open -n "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}"
fi
