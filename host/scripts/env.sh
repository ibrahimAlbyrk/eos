# Source this: the build environment of the host workspace. Caches live under .work/ (not in
# git): cargo's registry, the CEF distribution (~460 MB, downloaded on the first build), the
# target folder and the pinned cmake, ninja and esbuild that scripts/setup.sh fetches. Set
# EOS_HOST_WORK to keep them elsewhere.
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export HOST_DIR
export EOS_HOST_WORK="${EOS_HOST_WORK:-$HOST_DIR/.work}"
export CARGO_HOME="$EOS_HOST_WORK/cargo-home"
export CARGO_TARGET_DIR="$EOS_HOST_WORK/target"
export CEF_PATH="$EOS_HOST_WORK/cef"
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}"
# cef-dll-sys builds CEF's C++ wrapper with cmake and ninja. Not found is an empty answer, in
# bash and zsh alike, never a failure that a sourcing script's `set -e` would silently end on.
CMAKE_BIN="$(find "$EOS_HOST_WORK/tools" -maxdepth 4 -type d -path "*/CMake.app/Contents/bin" 2>/dev/null | head -1 || true)"
NINJA_BIN="$(find "$EOS_HOST_WORK/tools" -maxdepth 1 -type d -name "ninja-*" 2>/dev/null | head -1 || true)"
export PATH="${CMAKE_BIN:+$CMAKE_BIN:}${NINJA_BIN:+$NINJA_BIN:}$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

# The esbuild release the plugin builder speaks (its packets are private to a release), and
# where setup.sh puts it. Development builds and tests of a checkout look there too
# (`eos_plugin_build::locate`).
esbuild_version() {
  sed -n 's/^pub const ESBUILD_VERSION: &str = "\(.*\)";/\1/p' "$HOST_DIR/../crates/eos-plugin-build/src/service.rs"
}
ESBUILD_BIN="$EOS_HOST_WORK/tools/esbuild-$(esbuild_version)/esbuild"

# What a build or a check needs from scripts/setup.sh. One line naming it when something is
# missing, instead of a failure deep inside a build.
require_setup() {
  local repo missing=()
  repo="$(cd "$HOST_DIR/.." && pwd)"
  command -v cargo >/dev/null || missing+=("cargo")
  [ -n "$CMAKE_BIN" ] || missing+=("cmake")
  [ -n "$NINJA_BIN" ] || missing+=("ninja")
  [ -x "$ESBUILD_BIN" ] || missing+=("esbuild")
  [ -f "$repo/app/ui/dist/index.html" ] || missing+=("the dashboard build")
  [ ${#missing[@]} -eq 0 ] && return 0
  echo "not set up (missing: ${missing[*]}): run host/scripts/setup.sh" >&2
  return 1
}
