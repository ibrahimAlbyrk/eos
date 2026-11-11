#!/bin/bash
# Builds Eos.app: the `eos` binary, the dashboard, the CEF framework and its five helper
# apps. Everything is built from this repo; nothing is swapped in after the build.
#
#   usage: bundle.sh [release|debug]          prints the path of the .app
#
#   EOS_BUNDLE_FEATURES  cargo features of the binary. Default `dev-proxy`: most routes are
#                        not ported yet, so the ones the Rust router does not declare go to
#                        an isolated Node daemon. Set it empty for a build without the proxy.
#   EOS_BUNDLE_ID        bundle identifier. Default `dev.eos.shell`, so a local build never
#                        shares system state (notifications, local network, single instance)
#                        with the installed Eos (`com.ibrahimalbyrk.eos`).
#   EOS_UI_DIST          the built dashboard. Default `app/ui/dist` of this checkout.
#   EOS_ESBUILD          the esbuild binary that builds plugins. Default: the one `npm ci`
#                        puts under `infra/node_modules` for this Mac. It must be the release
#                        `eos-plugin-build` speaks; without one the bundle is not made.
set -euo pipefail
source "$(dirname "$0")/env.sh"
PROFILE="${1:-release}"
FEATURES="${EOS_BUNDLE_FEATURES-dev-proxy}"
ID="${EOS_BUNDLE_ID:-dev.eos.shell}"
NAME="Eos"
REPO="$(cd "$HOST_DIR/../.." && pwd)"
DIST="${EOS_UI_DIST:-$REPO/app/ui/dist}"
[ -f "$DIST/index.html" ] || { echo "no dashboard at $DIST: run 'npm ci && npm run build' in app/ui" >&2; exit 1; }
# The plugin builder talks to one esbuild release only (its packets are private to a release).
ESBUILD_VERSION="$(sed -n 's/^pub const ESBUILD_VERSION: &str = "\(.*\)";/\1/p' "$REPO/rust/crates/eos-plugin-build/src/service.rs")"
ESBUILD="${EOS_ESBUILD:-$(ls "$REPO"/infra/node_modules/@esbuild/darwin-*/bin/esbuild 2>/dev/null | head -1)}"
[ -x "$ESBUILD" ] || { echo "no esbuild binary: run 'npm ci' in infra, or set EOS_ESBUILD" >&2; exit 1; }
[ "$("$ESBUILD" --version)" = "$ESBUILD_VERSION" ] || { echo "$ESBUILD is not esbuild $ESBUILD_VERSION" >&2; exit 1; }

cd "$HOST_DIR"
FLAG=(); [ "$PROFILE" = "release" ] && FLAG=(--release)
cargo build ${FLAG[@]+"${FLAG[@]}"} -p eos --features "$FEATURES" >&2
# Its own build: the helper wants the `cef` crate with other features than the app.
cargo build ${FLAG[@]+"${FLAG[@]}"} -p eos-cef-helper >&2

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
FRAMEWORK="$(ls -d "$CEF_PATH"/*/cef_macos_*/"Chromium Embedded Framework.framework" | head -1)"
[ -d "$FRAMEWORK" ] || { echo "no CEF framework under $CEF_PATH" >&2; exit 1; }
BIN="$CARGO_TARGET_DIR/$PROFILE"
APP="$EOS_HOST_WORK/bundle/$PROFILE/$NAME.app"
fill() { sed -e "s/@NAME@/$NAME/g" -e "s/@ID@/$ID/g" -e "s/@VERSION@/$VERSION/g" -e "s/@HELPER@/${2:-}/g" "$1"; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
fill bundle/Info.plist.in > "$APP/Contents/Info.plist"
cp "$BIN/eos" "$APP/Contents/MacOS/$NAME"
cp "$REPO/app/build/icon.icns" "$APP/Contents/Resources/icon.icns"
# Banners play it by name; macOS finds it in the bundle's resources.
cp "$REPO/app/build/eos-notification.aiff" "$APP/Contents/Resources/"
cp -R "$DIST" "$APP/Contents/Resources/dist"
# What the core finds through `Options.resources`: the plugin builder's esbuild (sign.sh
# signs it again with the app's identity) and the skill that teaches agents to write plugins.
cp "$ESBUILD" "$APP/Contents/Resources/esbuild"
cp -R "$REPO/rust/assets/claude-plugin" "$APP/Contents/Resources/claude-plugin"
# -c: a clone copy where the volume supports it (APFS), so the 320 MB framework costs nothing.
cp -Rc "$FRAMEWORK" "$APP/Contents/Frameworks/" 2>/dev/null || cp -R "$FRAMEWORK" "$APP/Contents/Frameworks/"

# CEF runs its renderer, GPU and utility processes from these, named after the main executable.
for suffix in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  helper="$NAME Helper$suffix"
  dir="$APP/Contents/Frameworks/$helper.app/Contents"
  mkdir -p "$dir/MacOS" "$dir/Resources"
  fill bundle/Helper-Info.plist.in "$helper" > "$dir/Info.plist"
  cp "$BIN/eos-cef-helper" "$dir/MacOS/$helper"
done
echo "$APP"
