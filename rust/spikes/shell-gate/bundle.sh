#!/bin/bash
# Builds the .app with the official Tauri 3 CLI, then (unless --stock-helper) replaces the
# executable of the five CEF helper apps with the patched helper (no-bridge aware).
# usage: bundle.sh [debug|release] [--stock-helper]
set -euo pipefail
G="$(cd "$(dirname "$0")" && pwd)"
source "$G/env.sh"
PROFILE="${1:-debug}"; STOCK="${2:-}"
cd "$G/app"
if [ "$PROFILE" = "release" ]; then cargo tauri build --bundles app --no-sign --ci; else cargo tauri build --debug --bundles app --no-sign --ci; fi
APP="$G/.work/target/$PROFILE/bundle/macos/EosShellGate.app"
PATCHED="$APP/Contents/MacOS/eos-shell-gate-helper"
if [ "$STOCK" != "--stock-helper" ]; then
  for suffix in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
    name="eos-shell-gate Helper$suffix"
    cp "$PATCHED" "$APP/Contents/Frameworks/$name.app/Contents/MacOS/$name"
  done
  echo "helper: patched (no-bridge aware)"
else
  echo "helper: stock (tauri-bundler)"
fi
# The bundler copies every [[bin]] into Contents/MacOS; the helper source binary is not needed there.
rm -f "$PATCHED"
echo "$APP"
