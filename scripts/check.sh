#!/usr/bin/env bash
# Everything CI runs, in order. Fails on the first problem.
set -euo pipefail
cd "$(dirname "$0")/.."

# The agent engine's checkout must be linked, at a commit that holds SDK_REV.
scripts/link-sdk.sh --check
cargo fmt --all --check
cargo clippy --workspace --all-targets --quiet -- -D warnings
cargo test --workspace --quiet
cargo xtask layers
cargo xtask shell
