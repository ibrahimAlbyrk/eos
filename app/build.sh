#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="Claude Manager"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

echo "compiling…"
swiftc -O \
  -o "$APP_BUNDLE/Contents/MacOS/ClaudeManager" \
  -framework Cocoa -framework WebKit \
  "$SCRIPT_DIR/main.swift"

cp "$SCRIPT_DIR/Info.plist" "$APP_BUNDLE/Contents/"

LOGO="$REPO_ROOT/manager/web/public/logo.png"
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

echo "done → $APP_BUNDLE"
echo ""
echo "run:     open '$APP_BUNDLE'"
echo "install: cp -r '$APP_BUNDLE' /Applications/"
