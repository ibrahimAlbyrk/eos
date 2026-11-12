#!/usr/bin/env bash
# Everything CI runs for the host workspace (Tauri + CEF), in order. Fails on the first
# problem. The main workspace's scripts/check.sh covers the rest and never builds CEF.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$HOST_DIR"

# The vendored runtime and the helper keep upstream's formatting: only our crates.
cargo fmt -p eos -p eos-apply -p eos-shell --check
cargo clippy -p eos -p eos-apply -p eos-shell --all-targets --quiet -- -D warnings
cargo clippy -p eos -p eos-shell --all-targets --features eos/dev-proxy --quiet -- -D warnings
cargo build -p eos-cef-helper --quiet
# The update applier: its swap and rollback, on throwaway bundle folders.
cargo test -p eos-apply --quiet
# The bridge's dev proxy: the main workspace checks the bridge without that feature.
cargo clippy --manifest-path ../Cargo.toml -p eos-bridge --all-targets --features dev-proxy --quiet -- -D warnings
cargo test --manifest-path ../Cargo.toml -p eos-bridge --features dev-proxy --quiet
node tests/lan_guard_test.mjs
node tests/bridge_script_test.mjs
scripts/check-patches.sh
(cd .. && cargo xtask layers && cargo xtask shell)
