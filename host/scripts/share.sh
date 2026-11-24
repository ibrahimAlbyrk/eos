#!/bin/bash
# Builds the share extension (`host/share/`) into an app's Contents/PlugIns/EosShare.appex.
# Its identifier, name, version and link scheme follow the app's Info.plist, so the extension
# hands what is shared to that app alone. Signed ad hoc and sandboxed here (extensions must
# be); sign.sh signs it again with the app's identity. bundle.sh runs it for the installed
# identity only; spikes/share-extension/spike.sh runs it for its stand-in app.
#
#   usage: share.sh <path to .app>
set -euo pipefail
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"
read_key() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist"; }
ID="$(read_key CFBundleIdentifier)"
NAME="$(read_key CFBundleName)"
VERSION="$(read_key CFBundleShortVersionString)"
SCHEME="$(read_key CFBundleURLTypes:0:CFBundleURLSchemes:0)"
APPEX="$APP/Contents/PlugIns/EosShare.appex"
rm -rf "$APPEX"
mkdir -p "$APPEX/Contents/MacOS"
sed -e "s/@ID@/$ID/g" -e "s/@NAME@/$NAME/g" -e "s/@VERSION@/$VERSION/g" -e "s/@SCHEME@/$SCHEME/g" \
  "$HOST_DIR/share/Info.plist.in" > "$APPEX/Contents/Info.plist"
# An extension starts at _NSExtensionMain, never at top-level code: -parse-as-library makes
# the Swift globals lazy, else they are never set and the extension crashes on first use.
xcrun swiftc -O -target arm64-apple-macos14.0 -application-extension -parse-as-library \
  -module-name EosShare -Xlinker -e -Xlinker _NSExtensionMain \
  -o "$APPEX/Contents/MacOS/EosShare" "$HOST_DIR"/share/*.swift >&2
codesign --force -s - --options runtime --entitlements "$HOST_DIR/bundle/share.entitlements" "$APPEX" 2>/dev/null
SHOWN="$(codesign -d --entitlements - "$APPEX" 2>/dev/null)"
grep -q com.apple.security.app-sandbox <<<"$SHOWN" || { echo "the share extension is not sandboxed" >&2; exit 1; }
