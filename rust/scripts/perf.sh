#!/usr/bin/env bash
# Timing checks. They assert speed, so they are kept out of check.sh: run them
# on a machine that is not busy with other builds.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo test --release -p eos-genui --test perf --quiet -- --ignored
# Terminals: MB/s from the PTY to a client's stream, memory under a flood.
cargo test --release -p eos-mod-terminals --test flood -- --ignored --nocapture --test-threads 1
cargo test --release -p eos-bridge --test terminal_flood -- --ignored --nocapture
