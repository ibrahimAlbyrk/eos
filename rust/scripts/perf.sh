#!/usr/bin/env bash
# Timing checks. They assert speed, so they are kept out of check.sh: run them
# on a machine that is not busy with other builds.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo test --release -p eos-genui --test perf --quiet -- --ignored
