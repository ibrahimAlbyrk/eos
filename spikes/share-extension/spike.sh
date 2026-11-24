#!/usr/bin/env bash
# Can a sandboxed macOS share extension hand what was shared to the app that contains it
# (07 G15)? Builds a stand-in app (`Host.swift`, scheme `eos-spike`, never `eos`) holding the
# extension (`Share.swift`, sandboxed), registers both for this run only, shares a file, a text
# and a web address through the extension the way the Share menu does (`Drive.swift`), and
# prints what the stand-in received.
#
#   spikes/share-extension/spike.sh
#
# Everything it registers is removed again on exit: the extension (pluginkit), the app
# (lsregister) and the build folder. The system keeps the extension's sandbox container
# (~/Library/Containers/dev.eos.spike.share-host.share, the folders sandboxing makes for it):
# containermanagerd refuses its removal. Every run reuses that one.
#
# What it showed (macOS 27.3, ad hoc signatures):
# - The sandboxed extension opens files with the containing app by the app's location
#   (NSWorkspace open withApplicationAt), the Dock's path, and the app receives the files.
# - It opens a `send` link in the containing app's scheme the same way, so the link reaches
#   that app and never another build that answers the scheme.
# - A sandboxed caller may open only what the target app claims: without document types
#   (public.item, public.folder) the open fails with kLSAppDoesNotClaimTypeErr. Rank None is
#   enough. The same holds for a link's scheme.
# - Shared text arrives as the item's attributedContentText, not as an attachment.
# - The extension's executable starts at _NSExtensionMain, so its Swift must be compiled with
#   -parse-as-library: top-level globals are otherwise never initialized and it crashes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ID=dev.eos.spike.share-host
EXT_ID=$ID.share
TITLE="Eos Spike"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
WORK="$(cd "$(mktemp -d)" && pwd -P)"
APP="$WORK/Host.app"
APPEX="$APP/Contents/PlugIns/Share.appex"

cleanup() {
  pluginkit -r "$APPEX" 2>/dev/null || true
  "$LSREGISTER" -u "$APP" 2>/dev/null || true
  pkill -f "$APP/Contents/MacOS/host" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

plist() { # path, then key/value pairs written as given
  local path=$1; shift
  { echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'; printf '%s\n' "$@"; echo '</dict></plist>'; } >"$path"
}

mkdir -p "$APP/Contents/MacOS" "$APPEX/Contents/MacOS"
plist "$APP/Contents/Info.plist" \
  "<key>CFBundleIdentifier</key><string>$ID</string>" \
  "<key>CFBundleExecutable</key><string>host</string>" \
  "<key>CFBundlePackageType</key><string>APPL</string>" \
  "<key>LSUIElement</key><true/>" \
  "<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Item</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>None</string><key>LSItemContentTypes</key><array><string>public.item</string><string>public.folder</string></array></dict></array>" \
  "<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>$ID</string><key>CFBundleURLSchemes</key><array><string>eos-spike</string></array></dict></array>"
plist "$APPEX/Contents/Info.plist" \
  "<key>CFBundleIdentifier</key><string>$EXT_ID</string>" \
  "<key>CFBundleExecutable</key><string>share</string>" \
  "<key>CFBundleDisplayName</key><string>$TITLE</string>" \
  "<key>CFBundleName</key><string>$TITLE</string>" \
  "<key>CFBundlePackageType</key><string>XPC!</string>" \
  "<key>CFBundleShortVersionString</key><string>1.0</string>" \
  "<key>CFBundleVersion</key><string>1</string>" \
  "<key>LSMinimumSystemVersion</key><string>14.0</string>" \
  "<key>EosLinkScheme</key><string>eos-spike</string>" \
  "<key>NSExtension</key><dict>
     <key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>
     <key>NSExtensionPrincipalClass</key><string>ShareViewController</string>
     <key>NSExtensionAttributes</key><dict><key>NSExtensionActivationRule</key><dict>
       <key>NSExtensionActivationSupportsText</key><true/>
       <key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>1</integer>
       <key>NSExtensionActivationSupportsFileWithMaxCount</key><integer>20</integer>
     </dict></dict>
   </dict>"

xcrun swiftc -O -target arm64-apple-macos14.0 -o "$APP/Contents/MacOS/host" "$HERE/Host.swift"
xcrun swiftc -O -target arm64-apple-macos14.0 -application-extension -parse-as-library -module-name Share \
  -Xlinker -e -Xlinker _NSExtensionMain -o "$APPEX/Contents/MacOS/share" "$HERE/Share.swift"
xcrun swiftc -O -target arm64-apple-macos14.0 -o "$WORK/drive" "$HERE/Drive.swift"
codesign --force -s - --options runtime --entitlements "$HERE/share.entitlements" "$APPEX"
codesign --force -s - --options runtime "$APP"
codesign --verify --deep --strict "$APP"
codesign -d --entitlements - "$APPEX" 2>/dev/null | grep -q app-sandbox || { echo "the extension is not sandboxed" >&2; exit 1; }

"$LSREGISTER" -f "$APP"
pluginkit -a "$APPEX"
pluginkit -e use -i "$EXT_ID"
pluginkit -m -i "$EXT_ID" -v

echo "shared file" >"$WORK/a file + more.txt"
share() { # kind value expected
  rm -f "$WORK/received.txt"
  echo "== $1"
  "$WORK/drive" "$TITLE" "$1" "$2" || true
  for _ in $(seq 1 40); do [ -s "$WORK/received.txt" ] && break; sleep 0.25; done
  local got; got="$(cat "$WORK/received.txt" 2>/dev/null || true)"
  echo "received: ${got:-nothing}"
  [ "$got" = "$3" ] && echo "PASS" || echo "FAIL (wanted $3)"
}
share file "$WORK/a file + more.txt" "file://${WORK// /%20}/a%20file%20+%20more.txt"
share text "hi there + 1 & ü" "eos-spike://send?text=hi%20there%20%2B%201%20%26%20%C3%BC"
share url "https://example.com/a?b=c" "eos-spike://send?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc"
