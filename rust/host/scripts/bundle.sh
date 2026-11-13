#!/bin/bash
# Builds Eos.app: the `eos` binary, the dashboard, the CEF framework and its five helper
# apps. Everything is built from this repo; nothing is swapped in after the build.
#
#   usage: bundle.sh [release|debug]          prints the path of the .app
#
#   EOS_BUNDLE_FEATURES  cargo features of the binary. Default `dev-proxy`: the few routes the
#                        Rust router does not declare go to an isolated Node daemon. Set it
#                        empty for a build without the proxy.
#   EOS_BUNDLE_ID        bundle identifier. Default `dev.eos.shell`, so a local build never
#                        shares system state (notifications, local network, single instance)
#                        with the installed Eos (`com.ibrahimalbyrk.eos`).
#   EOS_UI_DIST          the built dashboard. Default `app/ui/dist` of this checkout.
#   EOS_ESBUILD          the esbuild binary that builds plugins. Default: the one `npm ci`
#                        puts under `infra/node_modules` for this Mac. It must be the release
#                        `eos-plugin-build` speaks; without one the bundle is not made.
#   EOS_UPDATE_CHANNEL   `stable` marks the bundle as a release that updates itself
#                        (Resources/update.json). Unset for every other build: a build from
#                        source never replaces itself. See ../docs/first-rust-release.md.
set -euo pipefail
source "$(dirname "$0")/env.sh"
require_setup
PROFILE="${1:-release}"
FEATURES="${EOS_BUNDLE_FEATURES-dev-proxy}"
ID="${EOS_BUNDLE_ID:-dev.eos.shell}"
NAME="Eos"
REPO="$(cd "$HOST_DIR/../.." && pwd)"
DIST="${EOS_UI_DIST:-$REPO/app/ui/dist}"
[ -f "$DIST/index.html" ] || { echo "no dashboard at $DIST: run rust/host/scripts/setup.sh" >&2; exit 1; }
# The plugin builder talks to one esbuild release only (its packets are private to a release).
ESBUILD_VERSION="$(sed -n 's/^pub const ESBUILD_VERSION: &str = "\(.*\)";/\1/p' "$REPO/rust/crates/eos-plugin-build/src/service.rs")"
ESBUILD="${EOS_ESBUILD:-$(ls "$REPO"/infra/node_modules/@esbuild/darwin-*/bin/esbuild 2>/dev/null | head -1)}"
[ -x "$ESBUILD" ] || { echo "no esbuild binary: run rust/host/scripts/setup.sh, or set EOS_ESBUILD" >&2; exit 1; }
[ "$("$ESBUILD" --version)" = "$ESBUILD_VERSION" ] || { echo "$ESBUILD is not esbuild $ESBUILD_VERSION" >&2; exit 1; }

cd "$HOST_DIR"
FLAG=(); [ "$PROFILE" = "release" ] && FLAG=(--release)
cargo build ${FLAG[@]+"${FLAG[@]}"} -p eos --features "$FEATURES" >&2
# Its own build: the helper wants the `cef` crate with other features than the app.
cargo build ${FLAG[@]+"${FLAG[@]}"} -p eos-cef-helper >&2
# The update applier: runs while the app is closed, so it links nothing of the app.
cargo build ${FLAG[@]+"${FLAG[@]}"} -p eos-apply >&2

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
FRAMEWORK="$(ls -d "$CEF_PATH"/*/cef_macos_*/"Chromium Embedded Framework.framework" | head -1)"
[ -d "$FRAMEWORK" ] || { echo "no CEF framework under $CEF_PATH" >&2; exit 1; }
BIN="$CARGO_TARGET_DIR/$PROFILE"
APP="$EOS_HOST_WORK/bundle/$PROFILE/$NAME.app"
fill() { sed -e "s/@NAME@/$NAME/g" -e "s/@ID@/$ID/g" -e "s/@VERSION@/$VERSION/g" -e "s/@HELPER@/${2:-}/g" "$1"; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
fill bundle/Info.plist.in > "$APP/Contents/Info.plist"
# The system allocator keeps every large block it gets back (up to a limit of its own),
# and Activity Monitor counts it: the core's long lists and the app's own large buffers
# would hold hundreds of MB after use. The soak (crates/eos-app/examples/soak.rs) measures
# the app with it off and holds the footprint to a ceiling.
grep -q "<key>MallocLargeCache</key>" "$APP/Contents/Info.plist" \
  || { echo "Info.plist lost MallocLargeCache" >&2; exit 1; }
cp "$BIN/eos" "$APP/Contents/MacOS/$NAME"
cp "$BIN/eos-apply" "$APP/Contents/MacOS/eos-apply"
if [ "${EOS_UPDATE_CHANNEL:-}" = "stable" ]; then
  printf '{"version":"%s","channel":"stable","platform":"darwin-arm64"}' "$VERSION" > "$APP/Contents/Resources/update.json"
fi
cp "$REPO/app/build/icon.icns" "$APP/Contents/Resources/icon.icns"
# Banners play it by name; macOS finds it in the bundle's resources.
cp "$REPO/app/build/eos-notification.aiff" "$APP/Contents/Resources/"
cp -R "$DIST" "$APP/Contents/Resources/dist"
# What the core finds through `Options.resources`: the plugin builder's esbuild (sign.sh
# signs it again with the app's identity) and the skill that teaches agents to write plugins.
cp "$ESBUILD" "$APP/Contents/Resources/esbuild"
cp -R "$REPO/rust/assets/claude-plugin" "$APP/Contents/Resources/claude-plugin"
# The PDF viewer of the raw-content origin (`Options.pdfjs_root`).
cp -R "$REPO/manager/vendor/pdfjs" "$APP/Contents/Resources/pdfjs"
# The CoreLocation helper the core runs for `GET /api/location`. A bundle, not a bare
# binary: macOS shows the location prompt only for a bundle's executable, and keys the
# permission by the helper's own identifier, which follows the app's (a local build never
# shares the installed app's Location Services entry). Signed ad hoc here; sign.sh signs it
# again with the app's identity. Never run by a test.
LOCATION="$APP/Contents/Resources/EosLocation.app/Contents"
mkdir -p "$LOCATION/MacOS"
xcrun swiftc -O -target arm64-apple-macos14.0 -o "$LOCATION/MacOS/eos-location" "$REPO/app/location/main.swift" >&2
sed -e "s/<string>com\.ibrahimalbyrk\.eos\.location<\/string>/<string>$ID.location<\/string>/" \
  "$REPO/app/location/Info.plist" > "$LOCATION/Info.plist"
grep -q "<string>$ID.location</string>" "$LOCATION/Info.plist" \
  || { echo "the location helper's identifier was not set" >&2; exit 1; }
codesign --force -s - "$APP/Contents/Resources/EosLocation.app" 2>/dev/null
# -c: a clone copy where the volume supports it (APFS), so the 320 MB framework costs nothing.
cp -Rc "$FRAMEWORK" "$APP/Contents/Frameworks/" 2>/dev/null || cp -R "$FRAMEWORK" "$APP/Contents/Frameworks/"

# The executables name the framework in a load command, so dyld maps it at launch and its
# constant data stays clean in every process (about 70 MB for the app: README, "Memory").
# The linker wrote the path as the main executable sees it; a helper sits three folders
# deeper. Changing the path drops the linker's signature, so the helper is signed again ad
# hoc (sign.sh replaces that with the real identity). An executable without the load command
# would fall back to dlopen() without anyone noticing: that fails the build here.
FW="Chromium Embedded Framework.framework/Chromium Embedded Framework"
HELPER_BIN="$EOS_HOST_WORK/bundle/$PROFILE/helper"
cp "$BIN/eos-cef-helper" "$HELPER_BIN"
install_name_tool -change "@executable_path/../Frameworks/$FW" "@executable_path/../../../$FW" "$HELPER_BIN"
codesign --force -s - "$HELPER_BIN" 2>/dev/null
otool -L "$APP/Contents/MacOS/$NAME" | grep -qF "@executable_path/../Frameworks/$FW" \
  || { echo "the app's executable does not map the CEF framework at launch" >&2; exit 1; }
otool -L "$HELPER_BIN" | grep -qF "@executable_path/../../../$FW" \
  || { echo "the helper executable does not map the CEF framework at launch" >&2; exit 1; }

# CEF runs its renderer, GPU and utility processes from these, named after the main executable.
for suffix in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  helper="$NAME Helper$suffix"
  dir="$APP/Contents/Frameworks/$helper.app/Contents"
  mkdir -p "$dir/MacOS" "$dir/Resources"
  fill bundle/Helper-Info.plist.in "$helper" > "$dir/Info.plist"
  cp "$HELPER_BIN" "$dir/MacOS/$helper"
done
rm -f "$HELPER_BIN"
echo "$APP"
