#!/bin/bash
# Signs the bundle locally with the Developer ID identity, inside out: the framework's
# libraries, the framework, the helper apps, the app; hardened runtime and the CEF
# entitlements on the executables.
#
# --timestamp=none on purpose: nothing is sent to Apple's timestamp service, nothing is
# notarized, nothing is uploaded. A release needs the secure timestamp and notarization;
# that is a separate, deliberate step.
#
#   usage: sign.sh <path to .app> [identity substring, default "Developer ID Application"]
set -euo pipefail
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"; WANT="${2:-Developer ID Application}"
ID="$(security find-identity -v -p codesigning | grep "$WANT" | head -1 | sed -E 's/.*"(.*)"/\1/')"
[ -n "$ID" ] || { echo "no signing identity matching: $WANT" >&2; exit 1; }
ENT="$HOST_DIR/bundle/entitlements.plist"
FW="$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
# The identity's hash never reaches the output.
sign() { codesign --force --timestamp=none -s "$ID" "$@" 2>&1 | sed -E 's/[0-9A-F]{40}/<hash>/g'; }
for lib in "$FW"/Libraries/*.dylib; do sign "$lib"; done
sign "$FW"
for helper in "$APP"/Contents/Frameworks/*.app; do sign --options runtime --entitlements "$ENT" "$helper"; done
sign --options runtime --entitlements "$ENT" "$APP"
codesign --verify --deep --strict "$APP" && echo "signed and verified: $APP"
