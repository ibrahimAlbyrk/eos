#!/usr/bin/env bash
# Boots today's Node daemon on one copy of a data folder and the Rust core on
# another, stops both cleanly, then compares what each left on disk with a third,
# untouched copy (scripts/boot_compare.py): rows removed, added or rewritten per
# table, files added, removed or changed. Prints names and counts only.
#
#   boot-compare.sh <sanitized data folder> [work folder]
#
# The copies are made by private-copy.sh (the user's paths moved into throwaway
# repositories). The daemon runs in isolation (wire-daemon.sh, ports
# EOS_WIRE_PORT/EOS_WIRE_RAW_PORT, default 7630/7631) and is stopped at the end.
set -euo pipefail

src="$(cd "${1:?a sanitized data folder}" && pwd -P)"
work="${2:-$(dirname "$src")}"
rust="$(cd "$(dirname "$0")/.." && pwd)"
export EOS_WIRE_PORT="${EOS_WIRE_PORT:-7630}" EOS_WIRE_RAW_PORT="${EOS_WIRE_RAW_PORT:-7631}"
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

for side in b n r; do
  "$rust/scripts/private-copy.sh" "$src" "$work/boot-cmp-$side" >/dev/null
done
user="$work/boot-cmp-user"
mkdir -p "$user"

cargo build --quiet --release --manifest-path "$rust/Cargo.toml" -p eos-app --example boot_once
isolated() {
  mkdir -p "$user/.claude" "$user/tmp"
  env -i PATH="$PATH" HOME="$user" CLAUDE_CONFIG_DIR="$user/.claude" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
    SHELL="${SHELL:-/bin/sh}" TMPDIR="$user/tmp" LANG="en_US.UTF-8" TZ=UTC \
    EOS_REMOTE_ENABLED=0 EOS_PEER_ENABLED=0 "$@"
}

node_start="$(now_ms)"
trap '"$rust/scripts/wire-daemon.sh" stop "$work/boot-cmp-n"' EXIT
EOS_WIRE_USER_HOME="$user" "$rust/scripts/wire-daemon.sh" start "$work/boot-cmp-n" >/dev/null
sleep 3
"$rust/scripts/wire-daemon.sh" stop "$work/boot-cmp-n"
node_end="$(now_ms)"
echo "node: booted and stopped in $((node_end - node_start)) ms"

rust_start="$(now_ms)"
isolated "$rust/target/release/examples/boot_once" "$work/boot-cmp-r" 3 | sed 's/^/rust: /'
rust_end="$(now_ms)"

python3 "$rust/scripts/boot_compare.py" "$work/boot-cmp-b" \
  "$work/boot-cmp-n" "$node_start:$node_end" "$work/boot-cmp-r" "$rust_start:$rust_end"
