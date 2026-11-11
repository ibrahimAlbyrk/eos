# Source this: the build environment of the host workspace. Caches live under .work/ (not in
# git): cargo's registry, the CEF distribution (~460 MB, downloaded on the first build), the
# target folder and a private cmake. Set EOS_HOST_WORK to keep them elsewhere.
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export HOST_DIR
export EOS_HOST_WORK="${EOS_HOST_WORK:-$HOST_DIR/.work}"
export CARGO_HOME="$EOS_HOST_WORK/cargo-home"
export CARGO_TARGET_DIR="$EOS_HOST_WORK/target"
export CEF_PATH="$EOS_HOST_WORK/cef"
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}"
# cef-dll-sys builds CEF's C++ wrapper with cmake and ninja.
CMAKE_BIN="$(ls -d "$EOS_HOST_WORK"/tools/cmake-*/CMake.app/Contents/bin 2>/dev/null | head -1)"
export PATH="${CMAKE_BIN:+$CMAKE_BIN:}$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
