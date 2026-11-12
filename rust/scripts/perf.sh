#!/usr/bin/env bash
# Timing and memory checks. They assert speed and measure the process, so they
# are kept out of check.sh: run them on a machine that is not busy with other builds.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo test --release -p eos-genui --test perf --quiet -- --ignored
# Terminals: MB/s from the PTY to a client's stream, memory under a flood.
cargo test --release -p eos-mod-terminals --test flood -- --ignored --nocapture --test-threads 1
cargo test --release -p eos-bridge --test terminal_flood -- --ignored --nocapture
# The composed app on a data folder of real size: cold start, the hot reads, a burst
# of agent events, stream fan-out — each against its budget.
cargo test --release -p eos-app --test perf -- --ignored --nocapture --test-threads 1
# Thousands of sessions, subscribers, terminals, watches, jobs and views come and go:
# memory, descriptors, threads and tasks come back. The terminals' shell reads no profile.
SHELL=/bin/sh cargo test --release -p eos-app --test lifetimes -- --ignored --nocapture --test-threads 1
