#!/bin/bash
# Makes a clean checkout able to build, check and try the host workspace. Safe to run again:
# what is in place already is kept. Prints what it did.
#
#   - cmake and ninja (cef-dll-sys builds CEF's C++ wrapper with them): pinned releases from
#     their official GitHub release pages, checked against the SHA-256 below, under .work/tools
#   - node modules (`npm ci`, inside this checkout only) where the scripts need them: the
#     dashboard (app/ui), the plugin builder's esbuild (infra), the isolated dev daemon
#     (contracts, core, infra, gateway, spawner, manager)
#   - the dashboard's build (app/ui/dist), when it is missing or older than its sources
#
# CEF itself (~460 MB) is not fetched here: cef-dll-sys's build script downloads it on the
# first build into .work/cef and checks it against the CEF builds index's SHA-1.
#
# Needs, and says so when one is missing: rustup's cargo, Xcode (swiftc, codesign), node ≥ 23.6
# with npm, curl, shasum.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
REPO="$(cd "$HOST_DIR/../.." && pwd)"
TOOLS="$EOS_HOST_WORK/tools"

CMAKE_VERSION=3.31.6
CMAKE_SHA256=330b9514f5112e5ed4fb08b8b05803b776fd9b539a6ae12927d14dcc0ee2ba8d
NINJA_VERSION=1.12.1
NINJA_SHA256=89a287444b5b3e98f88a945afa50ce937b8ffd1dcc59c555ad9b1baf855298c9

say() { echo "setup: $*"; }
die() { echo "setup: $*" >&2; exit 1; }

# ---- what cannot be fetched here ---------------------------------------------------------
command -v cargo >/dev/null || die "no cargo: install Rust with rustup (https://rustup.rs)"
xcrun --find swiftc >/dev/null 2>&1 || die "no swiftc: install Xcode (the bundle builds the location helper)"
command -v codesign >/dev/null || die "no codesign: install Xcode's command line tools"
for tool in node npm curl shasum; do command -v "$tool" >/dev/null || die "no $tool on PATH"; done
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 6) ? 0 : 1)' \
  || die "node $NODE_VERSION is too old: the dev daemon and the tests need node 23.6 or later"

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

# ---- node modules ------------------------------------------------------------------------
# `npm ci` where the lockfile changed since the last install (npm records the tree it
# installed in node_modules/.package-lock.json).
for dir in contracts core infra gateway spawner manager app/ui; do
  installed="$REPO/$dir/node_modules/.package-lock.json"
  if [ -f "$installed" ] && [ "$installed" -nt "$REPO/$dir/package-lock.json" ]; then
    say "$dir: node modules up to date"
  else
    LOG="$EOS_HOST_WORK/npm-ci.log"
    (cd "$REPO/$dir" && npm ci --no-audit --no-fund >"$LOG" 2>&1) || die "npm ci failed in $dir (see $LOG)"
    say "$dir: npm ci"
  fi
done

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
