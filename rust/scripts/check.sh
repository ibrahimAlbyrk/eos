#!/usr/bin/env bash
# Everything CI runs, in order. Fails on the first problem.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo fmt --all --check
cargo clippy --workspace --all-targets --quiet -- -D warnings
cargo test --workspace --quiet
cargo xtask layers
