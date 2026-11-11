#!/bin/bash
# Signs the bundle locally, inside-out, in the order and with the flags tauri-bundler uses
# (CEF nested code first, then helpers, then the app; hardened runtime + entitlements on
# executables). One difference on purpose: --timestamp=none, so nothing is sent to Apple's
# timestamp service. A release build needs the secure timestamp (and notarization).
# usage: sign.sh <path to .app> [identity substring, default "Developer ID Application"]
set -euo pipefail
G="$(cd "$(dirname "$0")" && pwd)"
APP="$1"; WANT="${2:-Developer ID Application}"
ID="$(security find-identity -v -p codesigning | grep "$WANT" | head -1 | sed -E 's/.*"(.*)"/\1/')"
[ -n "$ID" ] || { echo "no identity matching: $WANT"; exit 1; }
FW="$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
sign() { codesign --force --timestamp=none -s "$ID" "$@" 2>&1 | sed -E 's/[0-9A-F]{40}/<hash>/g'; }
for lib in "$FW"/Libraries/*.dylib; do sign "$lib"; done
sign "$FW"
for h in "$APP"/Contents/Frameworks/*.app; do sign --options runtime --entitlements "$G/entitlements.plist" "$h"; done
sign --options runtime --entitlements "$G/entitlements.plist" "$APP"
echo "signed: $APP"
