#!/bin/bash
# Launches the gate app in the background against the isolated daemon and waits until its
# control loop answers.   usage: run.sh [debug|release]   (extra config through GATE_* env)
# Private data stays out of git: everything this writes goes under $GATE_DATA/shell-gate-out.
set -u
G="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${1:-debug}"
DATA="${GATE_DATA:-/Users/ibrahimalbyrk/Projects/CC/eos-rs-data}"
OUT="${GATE_OUT:-$DATA/shell-gate-out/run}"
APP="${GATE_APP:-$G/.work/target/$PROFILE/bundle/macos/EosShellGate.app}"
REPO="$(cd "$G/../../.." && pwd)"
mkdir -p "$OUT/ctl"
rm -f "$OUT/ready" "$OUT"/ctl/*.req "$OUT"/ctl/*.res
python3 -c 'import time; print(int(time.time()*1000))' > "$OUT/launch-epoch-ms"
ENVS=(--env "GATE_OUT=$OUT" --env "GATE_UI_DIST=${GATE_UI_DIST:-$REPO/app/ui/dist}"
      --env "GATE_API=${GATE_API:-http://127.0.0.1:7490}" --env "GATE_RAW=${GATE_RAW:-http://127.0.0.1:7491}"
      --env "GATE_TOKEN_FILE=${GATE_TOKEN_FILE:-$DATA/run-shell/ui-token}"
      --env "GATE_PROFILE=${GATE_PROFILE:-$DATA/shell-gate-out/profile}")
[ "${GATE_FOREGROUND:-}" = "1" ] || ENVS+=(--env "GATE_ACCESSORY=1" --env "TAURI_CEF_NO_ACTIVATE=1")
for v in GATE_LS_SEED GATE_PARK GATE_MAIN_BRIDGE GATE_TABS_BRIDGE GATE_NO_BROWSER_HOST GATE_WINDOW GATE_MAX_SECS GATE_START_PATH GATE_TL_Y; do
  [ -n "${!v:-}" ] && ENVS+=(--env "$v=${!v}")
done
open -g -n -W "$APP" --stdout "$OUT/app.out" --stderr "$OUT/app.err" "${ENVS[@]}" &
for _ in $(seq 1 200); do [ -f "$OUT/ready" ] && break; sleep 0.05; done
[ -f "$OUT/ready" ] && echo "ready pid=$(cat "$OUT/ready")" || { echo "not ready"; tail -5 "$OUT/app.err"; exit 1; }
