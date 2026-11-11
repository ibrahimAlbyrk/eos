# Source this: build environment for the shell gate. Everything lives under .work/ (not in git).
G="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export GATE="$G"
export CARGO_HOME="$G/.work/cargo-home"
export CARGO_TARGET_DIR="$G/.work/target"
export CEF_PATH="$G/.work/cef"
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS=4
export PATH="$G/.work/root/bin:$G/.work/tools/cmake-4.4.5-macos-universal/CMake.app/Contents/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
