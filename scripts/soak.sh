#!/usr/bin/env bash
# The soak: the whole app on a fresh copy of a data folder, driven for a long
# time by a seeded mixed workload on a scripted agent engine
# (crates/eos-app/examples/soak.rs says what runs and what passes).
#
#   soak.sh <sanitized data folder> [soak options]   e.g. --minutes 30 --rate 10 --csv out.csv
#   soak.sh --check-rule <sanitized data folder>     a short run with a deliberate leak: must FAIL
#
# The copy is made by private-copy.sh beside the source (soak-run, or $SOAK_COPY);
# the chats work in its throwaway copy of the first project folder. The run has its
# own $HOME, Claude folder and TMPDIR; it opens no listener and dials nothing. Like the
# app (its Info.plist), it runs with the allocator's large-block cache off
# (MallocLargeCache=0); MallocLargeCache=1 soak.sh … measures it on.
set -euo pipefail

top="$(cd "$(dirname "$0")/.." && pwd)"
check=""
if [ "${1:-}" = "--check-rule" ]; then
  check=1
  shift
fi
src="$(cd "${1:?a sanitized data folder}" && pwd -P)"
shift
copy="${SOAK_COPY:-$(dirname "$src")/soak-run}"
user="$copy-user"

cargo build --quiet --release --manifest-path "$top/Cargo.toml" -p eos-app --example soak
"$top/scripts/private-copy.sh" "$src" "$copy" >/dev/null
cwd="$(find "$copy-sb" -name .git -maxdepth 4 -type d | head -1)"
cwd="${cwd%/.git}"
mkdir -p "$user/.claude" "$user/tmp"
run() {
  env -i PATH="$PATH" HOME="$user" CLAUDE_CONFIG_DIR="$user/.claude" TMPDIR="$user/tmp" SHELL=/bin/sh \
    LANG=en_US.UTF-8 TZ=UTC EOS_REMOTE_ENABLED=0 EOS_PEER_ENABLED=0 MallocLargeCache="${MallocLargeCache-0}" \
    "$top/target/release/examples/soak" "$copy" ${cwd:+--cwd "$cwd"} "$@"
}

if [ -n "$check" ]; then
  # 128 KB a second kept for good, at ten times the rate, for four minutes.
  if run --minutes 4 --rate 10 --sample-secs 10 --leak-kb 128 "$@"; then
    echo "soak.sh: the rule let a deliberate leak pass" >&2
    exit 1
  fi
  echo "soak.sh: the rule failed the deliberate leak, as it must"
  exit 0
fi
run "$@"
