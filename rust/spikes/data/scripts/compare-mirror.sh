#!/bin/bash
# For every scripted session: the terminal state a client reaches from (a) the
# raw bytes, (b) today's xterm snapshot, (c) the Rust mirror's snapshot — each
# replayed into a fresh xterm.js terminal — compared cell by cell.
# Usage: scripts/compare-mirror.sh [dir with *.bin] [cols] [rows]
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_INCREMENTAL=0
cargo build -q --release -p spike-pty || exit 1
dir=${1:-fixtures/pty}; cols=${2:-80}; rows=${3:-24}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for f in "$dir"/*.bin; do
  name=$(basename "$f" .bin)
  node ts/mirror.ts state "$cols" "$rows" < "$f" > "$tmp/raw.json"
  node ts/mirror.ts snapshot "$f" "$cols" "$rows" > "$tmp/xterm.snap"
  target/release/mirror-snapshot "$f" "$cols" "$rows" > "$tmp/rust.snap"
  node ts/mirror.ts state "$cols" "$rows" < "$tmp/xterm.snap" > "$tmp/xterm.json"
  node ts/mirror.ts state "$cols" "$rows" < "$tmp/rust.snap" > "$tmp/rust.json"
  echo "$name  (raw $(stat -f %z "$f") B, xterm snapshot $(stat -f %z "$tmp/xterm.snap") B, rust snapshot $(stat -f %z "$tmp/rust.snap") B)"
  echo "  xterm snapshot vs raw:";  node ts/mirror-diff.ts "$tmp/raw.json" "$tmp/xterm.json"
  echo "  rust snapshot vs raw:";   node ts/mirror-diff.ts "$tmp/raw.json" "$tmp/rust.json"
done
