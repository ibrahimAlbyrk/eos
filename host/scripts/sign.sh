#!/bin/bash
# Signs the bundle locally with the Developer ID identity, inside out: the framework's
# libraries, the framework, the helper apps, the bundled esbuild, the applier, the `eos` command, the location
# helper, the screen saver, the share extension, the app; hardened runtime
# on the executables, and the CEF entitlements on those that run Chromium.
#
# --timestamp=none by default: nothing is sent to Apple's timestamp service, nothing is
# notarized, nothing is uploaded. `release` as the third argument asks Apple's timestamp
# service for a secure timestamp on every piece instead, as notarization requires; it needs a
# Developer ID identity. Notarizing and stapling stay a separate, deliberate step
# (docs/first-rust-release.md §2).
#
# `-` as the identity signs ad hoc, the same way: a signature of this build alone, with no
# identity behind it (what `cargo xtask install` uses when the keychain holds no Developer ID).
#
#   usage: sign.sh <path to .app> [identity substring, default "Developer ID Application"; - for ad hoc] [release]
set -euo pipefail
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"; WANT="${2:-Developer ID Application}"; MODE="${3:-local}"
case "$MODE" in
  local) STAMP=--timestamp=none ;;
  release) STAMP=--timestamp; [ "$WANT" != "-" ] || { echo "a release is never signed ad hoc" >&2; exit 1; } ;;
  *) echo "usage: sign.sh <app> [identity] [release]" >&2; exit 2 ;;
esac
if [ "$WANT" = "-" ]; then
  ID="-"
else
  ID="$(security find-identity -v -p codesigning | grep "$WANT" | head -1 | sed -E 's/.*"(.*)"/\1/')"
  [ -n "$ID" ] || { echo "no signing identity matching: $WANT" >&2; exit 1; }
fi
ENT="$HOST_DIR/bundle/entitlements.plist"
FW="$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
# The identity's hash never reaches the output.
sign() { codesign --force "$STAMP" -s "$ID" "$@" 2>&1 | sed -E 's/[0-9A-F]{40}/<hash>/g'; }
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
# The terminal's `eos` command: a program of its own, run from a link outside the bundle.
[ ! -f "$APP/Contents/Helpers/eos" ] || sign --options runtime "$APP/Contents/Helpers/eos"
LOCATION="$APP/Contents/Resources/EosLocation.app"
[ ! -d "$LOCATION" ] || sign --options runtime "$LOCATION"
# The screen saver: a loadable bundle of its own, copied out of the app when installed, so
# it carries the app's identity by itself.
SAVER="$APP/Contents/Resources/Eos.saver"
[ ! -d "$SAVER" ] || sign --options runtime "$SAVER"
# The share extension, in the installed identity's build only: sandboxed, as every extension.
SHARE="$APP/Contents/PlugIns/EosShare.appex"
[ ! -d "$SHARE" ] || sign --options runtime --entitlements "$HOST_DIR/bundle/share.entitlements" "$SHARE"
sign --options runtime --entitlements "$ENT" "$APP"
codesign --verify --deep --strict "$APP"
# Every program the bundle starts runs under the hardened runtime, nested ones included.
for code in "$APP" "$APP"/Contents/Frameworks/*.app "$APP/Contents/MacOS/eos-apply" "$APP/Contents/Helpers/eos" \
  "$LOCATION" "$APP"/Contents/PlugIns/*.appex; do
  [ -e "$code" ] || continue
  # Read whole first: grep -q would stop early, and pipefail counts the writer's broken pipe.
  shown="$(codesign -dv "$code" 2>&1)"
  grep -qE "flags=0x[0-9a-f]+\([^)]*runtime" <<<"$shown" || { echo "not under the hardened runtime: $code" >&2; exit 1; }
done
# The share extension, like every extension, runs in the sandbox.
for appex in "$APP"/Contents/PlugIns/*.appex; do
  [ -e "$appex" ] || continue
  shown="$(codesign -d --entitlements - "$appex" 2>/dev/null)"
  grep -q com.apple.security.app-sandbox <<<"$shown" || { echo "not sandboxed: $appex" >&2; exit 1; }
done
echo "signed and verified: $APP"
