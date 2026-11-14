#!/bin/bash
# Makes a clean checkout able to build, check and try the host workspace. Safe to run again:
# what is in place already is kept. Prints what it did.
#
#   - cmake and ninja (cef-dll-sys builds CEF's C++ wrapper with them): pinned releases from
#     their official GitHub release pages, checked against the SHA-256 below, under .work/tools
#   - esbuild, the plugin builder's (shipped in the bundle, found by development builds and
#     tests): the pinned release from the npm registry, checked against the SHA-256 below,
#     under .work/tools
#   - the dashboard's node modules (`npm ci` in app/ui, inside this checkout only) when its
#     lockfile changed since the last install, and its build (app/ui/dist) when it is missing
#     or older than its sources
#
# CEF itself (~460 MB) is not fetched here: cef-dll-sys's build script downloads it on the
# first build into .work/cef and checks it against the CEF builds index's SHA-1.
#
# Needs, and says so when one is missing: rustup's cargo, Xcode (swiftc, codesign), node with
# npm for the dashboard (20.19, or 22.12 or later: what its Vite needs), curl, shasum.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
REPO="$(cd "$HOST_DIR/.." && pwd)"
TOOLS="$EOS_HOST_WORK/tools"

CMAKE_VERSION=3.31.6
CMAKE_SHA256=330b9514f5112e5ed4fb08b8b05803b776fd9b539a6ae12927d14dcc0ee2ba8d
NINJA_VERSION=1.12.1
NINJA_SHA256=89a287444b5b3e98f88a945afa50ce937b8ffd1dcc59c555ad9b1baf855298c9
# The release `eos-plugin-build` speaks (ESBUILD_VERSION in its service.rs), per system.
ESBUILD_VERSION=0.28.2
ESBUILD_SHA256_ARM64=1980cde09749094452b20d36ff267585ccb3f72749c7bc97291cd9996ccf5a2a
ESBUILD_SHA256_X64=abb6a7a895aaf2cc0df36fecc3bf0042479ffec51a643a056d54e9109f27db55

say() { echo "setup: $*"; }
die() { echo "setup: $*" >&2; exit 1; }

# ---- what cannot be fetched here ---------------------------------------------------------
command -v cargo >/dev/null || die "no cargo: install Rust with rustup (https://rustup.rs)"
xcrun --find swiftc >/dev/null 2>&1 || die "no swiftc: install Xcode (the bundle builds the location helper)"
command -v codesign >/dev/null || die "no codesign: install Xcode's command line tools"
for tool in node npm curl shasum; do command -v "$tool" >/dev/null || die "no $tool on PATH"; done
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) || (a === 20 && b >= 19) ? 0 : 1)' \
  || die "node $NODE_VERSION is too old: the dashboard's build needs node 20.19, or 22.12 or later"
[ "$ESBUILD_VERSION" = "$(esbuild_version)" ] \
  || die "setup.sh pins esbuild $ESBUILD_VERSION, eos-plugin-build speaks $(esbuild_version): pin that release here"

# ---- pinned tools ------------------------------------------------------------------------
# Downloads `url` to `out` and keeps it only when its SHA-256 is `sha`.
fetch() {
  local url="$1" sha="$2" out="$3"
  curl -fsSL --retry 3 -o "$out.part" "$url" || { rm -f "$out.part"; die "could not download $url"; }
  local got
  got="$(shasum -a 256 "$out.part" | cut -d' ' -f1)"
  [ "$got" = "$sha" ] || { rm -f "$out.part"; die "$url: SHA-256 $got, expected $sha"; }
  mv "$out.part" "$out"
}

mkdir -p "$TOOLS"
CMAKE_DIR="$TOOLS/cmake-$CMAKE_VERSION"
if [ -x "$CMAKE_DIR/CMake.app/Contents/bin/cmake" ]; then
  say "cmake $CMAKE_VERSION already in .work/tools"
else
  # Another version found by env.sh's lookup would shadow this one.
  rm -rf "$TOOLS"/cmake-* "$TOOLS/cmake.tar.gz"
  fetch "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-macos-universal.tar.gz" \
    "$CMAKE_SHA256" "$TOOLS/cmake.tar.gz"
  tar -xzf "$TOOLS/cmake.tar.gz" -C "$TOOLS"
  mv "$TOOLS/cmake-$CMAKE_VERSION-macos-universal" "$CMAKE_DIR"
  rm -f "$TOOLS/cmake.tar.gz"
  say "cmake $CMAKE_VERSION fetched into .work/tools (SHA-256 checked)"
fi

NINJA_DIR="$TOOLS/ninja-$NINJA_VERSION"
if [ -x "$NINJA_DIR/ninja" ]; then
  say "ninja $NINJA_VERSION already in .work/tools"
else
  rm -rf "$TOOLS"/ninja-* "$TOOLS/ninja.zip"
  fetch "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-mac.zip" \
    "$NINJA_SHA256" "$TOOLS/ninja.zip"
  mkdir -p "$NINJA_DIR"
  unzip -q -o "$TOOLS/ninja.zip" -d "$NINJA_DIR"
  chmod +x "$NINJA_DIR/ninja"
  rm -f "$TOOLS/ninja.zip"
  say "ninja $NINJA_VERSION fetched into .work/tools (SHA-256 checked)"
fi

ESBUILD_DIR="$(dirname "$ESBUILD_BIN")"
if [ -x "$ESBUILD_BIN" ]; then
  say "esbuild $ESBUILD_VERSION already in .work/tools"
else
  case "$(uname -m)" in
    arm64) system=darwin-arm64 sha="$ESBUILD_SHA256_ARM64" ;;
    x86_64) system=darwin-x64 sha="$ESBUILD_SHA256_X64" ;;
    *) die "no pinned esbuild for $(uname -m)" ;;
  esac
  rm -rf "$TOOLS"/esbuild-* "$TOOLS/esbuild.tgz"
  fetch "https://registry.npmjs.org/@esbuild/$system/-/$system-$ESBUILD_VERSION.tgz" "$sha" "$TOOLS/esbuild.tgz"
  mkdir -p "$ESBUILD_DIR"
  tar -xzf "$TOOLS/esbuild.tgz" -C "$ESBUILD_DIR" --strip-components 2 package/bin/esbuild
  rm -f "$TOOLS/esbuild.tgz"
  [ "$("$ESBUILD_BIN" --version)" = "$ESBUILD_VERSION" ] || die "the fetched esbuild is not $ESBUILD_VERSION"
  say "esbuild $ESBUILD_VERSION fetched into .work/tools (SHA-256 checked)"
fi

# ---- the dashboard's node modules ----------------------------------------------------------
# `npm ci` when the lockfile changed since the last install (npm records the tree it
# installed in node_modules/.package-lock.json).
installed="$REPO/app/ui/node_modules/.package-lock.json"
if [ -f "$installed" ] && [ "$installed" -nt "$REPO/app/ui/package-lock.json" ]; then
  say "app/ui: node modules up to date"
else
  LOG="$EOS_HOST_WORK/npm-ci.log"
  (cd "$REPO/app/ui" && npm ci --no-audit --no-fund >"$LOG" 2>&1) || die "npm ci failed in app/ui (see $LOG)"
  say "app/ui: npm ci"
fi

# ---- the dashboard -----------------------------------------------------------------------
DIST="$REPO/app/ui/dist/index.html"
newer="$(find "$REPO/app/ui/src" "$REPO/app/ui/index.html" "$REPO/app/ui/package-lock.json" -newer "$DIST" -print -quit 2>/dev/null || true)"
if [ -f "$DIST" ] && [ -z "$newer" ]; then
  say "dashboard: app/ui/dist is current"
else
  LOG="$EOS_HOST_WORK/dashboard-build.log"
  (cd "$REPO/app/ui" && npm run build >"$LOG" 2>&1) || die "the dashboard build failed (see $LOG)"
  say "dashboard: built into app/ui/dist"
fi

# Looked up again: the tools fetched above were not there when env.sh first ran.
source "$HERE/env.sh"
require_setup && say "ready: scripts/try.sh build, scripts/check.sh"
