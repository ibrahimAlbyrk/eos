#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="Eos"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

echo "compiling…"
# Menu-bar status indicator lives in app/StatusBar/*.swift — the single-file
# layout means new sources must be listed here or they're never compiled.
swiftc -O \
  -target arm64-apple-macos13.0 \
  -o "$APP_BUNDLE/Contents/MacOS/Eos" \
  -framework Cocoa -framework WebKit -framework UserNotifications \
  "$SCRIPT_DIR/main.swift" \
  "$SCRIPT_DIR"/StatusBar/*.swift

cp "$SCRIPT_DIR/Info.plist" "$APP_BUNDLE/Contents/"
/usr/libexec/PlistBuddy -c "Add :EosRepoRoot string $REPO_ROOT" "$APP_BUNDLE/Contents/Info.plist"

LOGO="$REPO_ROOT/app/ui/public/logo.png"
if [ -f "$LOGO" ]; then
  echo "generating icon…"
  ICONSET="$BUILD_DIR/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$LOGO" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1
    double=$((size * 2))
    sips -z $double $double "$LOGO" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

# Bundle the built UI into the app. The WKWebView loads it from the eos://app/
# origin via the scheme handler in main.swift, so the daemon no longer serves
# it over HTTP.
WEB_DIST="$REPO_ROOT/app/ui/dist"
if [ ! -f "$WEB_DIST/index.html" ]; then
  echo "error: $WEB_DIST/index.html missing — run \`npm run build\` in app/ui first"
  exit 1
fi
cp -r "$WEB_DIST" "$APP_BUNDLE/Contents/Resources/ui"

INSTALLED="/Applications/$APP_NAME.app"
if [ -d "$INSTALLED" ]; then
  EXISTING_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INSTALLED/Contents/Info.plist" 2>/dev/null || echo "")
  if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "com.ibrahimalbyrk.eos" ]; then
    echo "error: $INSTALLED exists with different bundle ID ($EXISTING_ID); not overwriting"
    exit 1
  fi
fi
echo "installing → $INSTALLED"
rm -rf "$INSTALLED"
cp -r "$APP_BUNDLE" "$INSTALLED"

# eos build embeds its input stamp; must land before codesign so the
# signature stays valid.
if [ -n "${EOS_BUILD_STAMP:-}" ]; then
  printf '%s\n' "$EOS_BUILD_STAMP" > "$INSTALLED/Contents/Resources/.eos-stamp"
fi

echo "signing…"
codesign --force --deep --sign - "$INSTALLED"

# The replaced bundle gets a fresh ad-hoc CDHash every build; refresh the
# LaunchServices registration so a stale record can't fail the next launch.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$INSTALLED"
fi

echo "done → $INSTALLED"
