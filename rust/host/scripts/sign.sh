#!/bin/bash
# Signs the bundle locally with the Developer ID identity, inside out: the framework's
# libraries, the framework, the helper apps, the bundled esbuild, the app; hardened runtime
# on the executables, and the CEF entitlements on those that run Chromium.
#
# --timestamp=none on purpose: nothing is sent to Apple's timestamp service, nothing is
# notarized, nothing is uploaded. A release needs the secure timestamp and notarization;
# that is a separate, deliberate step.
#
# `-` as the identity signs ad hoc, the same way: a signature of this build alone, with no
# identity behind it (what `cargo xtask install` uses when the keychain holds no Developer ID).
#
#   usage: sign.sh <path to .app> [identity substring, default "Developer ID Application"; - for ad hoc]
set -euo pipefail
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"; WANT="${2:-Developer ID Application}"
if [ "$WANT" = "-" ]; then
  ID="-"
else
  ID="$(security find-identity -v -p codesigning | grep "$WANT" | head -1 | sed -E 's/.*"(.*)"/\1/')"
  [ -n "$ID" ] || { echo "no signing identity matching: $WANT" >&2; exit 1; }
fi
ENT="$HOST_DIR/bundle/entitlements.plist"
FW="$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
# The identity's hash never reaches the output.
sign() { codesign --force --timestamp=none -s "$ID" "$@" 2>&1 | sed -E 's/[0-9A-F]{40}/<hash>/g'; }
for lib in "$FW"/Libraries/*.dylib; do sign "$lib"; done
sign "$FW"
for helper in "$APP"/Contents/Frameworks/*.app; do sign --options runtime --entitlements "$ENT" "$helper"; done
# npm ships esbuild signed ad hoc by the linker: it gets the app's identity before the app is
# sealed. A plain program (no JIT, no Chromium): hardened runtime without entitlements.
ESBUILD="$APP/Contents/Resources/esbuild"
[ ! -f "$ESBUILD" ] || sign --options runtime "$ESBUILD"
# The update applier is a program of its own beside the main executable: signed by itself
# (it runs from a copy outside the bundle), with no entitlement.
[ -f "$APP/Contents/MacOS/eos-apply" ] && sign --options runtime "$APP/Contents/MacOS/eos-apply"
LOCATION="$APP/Contents/Resources/EosLocation.app"
[ ! -d "$LOCATION" ] || sign --options runtime "$LOCATION"
sign --options runtime --entitlements "$ENT" "$APP"
codesign --verify --deep --strict "$APP" && echo "signed and verified: $APP"
