#!/usr/bin/env bash
# Replays the recorded wire against the Rust core, in process (no daemon, no
# port): the judge of a route group. See fixtures/README.md.
#
#   replay.sh [--only 11-chats,12-transcript] [--verbose]
#       a fresh synthetic data folder (the recordings' seed), against fixtures/wire/recordings
#   replay.sh --private <copy> [--only …]
#       a copy of a real data folder (scripts/private-copy.sh), against fixtures/private (what the
#       daemon answered on another copy of the same folder, whose path has the same length).
#       Differences are printed without their values.
#
# Steps whose route the Rust core does not serve yet are counted apart ("not
# served yet"), and so are differences listed with their reason in
# fixtures/wire/rust-differences.toml; the exit status is non-zero only when
# an answered step differs in a way nobody listed.
# EOS_WIRE_RUN  where run folders are made (default: a folder per checkout under
#               $TMPDIR, so two checkouts replaying at once do not share data;
#               its name keeps the length of "eos-wire" because a few recorded
#               answers hold the path and sit near a size threshold)
set -euo pipefail

top="$(cd "$(dirname "$0")/.." && pwd)"
repo="$top"
wire="$top/fixtures/wire"
checkout="$(printf %s "$top" | shasum | cut -c1-3)"
root="${EOS_WIRE_RUN:-${TMPDIR:-/tmp}/eos-w$checkout}"
mkdir -p "$root"
root="$(cd "$root" && pwd -P)"

cargo build --quiet --manifest-path "$top/Cargo.toml" -p wire-recorder
tool="$top/target/debug/wire-recorder"
# The `claude` a synthetic run's Claude pane starts: the compiled stand-in, as the recording
# run had it. A run on a copy of real data gets none.
cargo build --quiet --manifest-path "$top/Cargo.toml" -p eos-mod-terminals --example fake_claude
mkdir -p "$root/bin"
ln -sf "$top/target/debug/examples/fake_claude" "$root/bin/claude"

# The core runs inside the tool: give it the recording daemon's surroundings
# (its own $HOME and Claude folder, UTC, a fixed locale, the phone link and
# hosting switched off), nothing of the caller's.
isolated() {
  local user="$1"
  shift
  mkdir -p "$user/.claude" "$user/tmp"
  env -i PATH="$PATH" HOME="$user" CLAUDE_CONFIG_DIR="$user/.claude" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
    SHELL="${SHELL:-/bin/sh}" TMPDIR="$user/tmp" LANG="en_US.UTF-8" TZ=UTC \
    EOS_REMOTE_ENABLED=0 EOS_PEER_ENABLED=0 "$@"
}

if [ "${1:-}" = "--private" ]; then
  home="$(cd "${2:?a copy of a real data folder}" && pwd -P)"
  shift 2
  user="$root/private-user"
  touch "$home/REAL_DATA"
  vars=(--var "home=$home" --var "user_home=$user" --var "repo=$repo")
  [ -d "$home-sb" ] && vars+=(--var "sandbox=$home-sb" --var "sandbox_slug=$(echo "$home-sb" | tr '/.' '--')" --var "home_slug=$(echo "$home" | tr '/.' '--')")
  while read -r flag value; do vars+=("$flag" "$value"); done < <("$top/scripts/private-vars.sh" "$home")
  isolated "$user" "$tool" replay --recordings "$top/fixtures/private" --rules "$wire/normalize.toml" \
    --known "$wire/rust-differences.toml" --rust-home "$home" --real-data --redact "${vars[@]}" "$@"
  exit
fi

run="$root/rust-replay"
home="$run/home" user="$run/user" sandbox="$run/sandbox"
rm -rf "$run"
mkdir -p "$home" "$user"
cp -R "$wire/seed/home/." "$home/"
cp -R "$wire/seed/user/." "$user/"
PATH="$root/bin:$PATH" "$top/scripts/stand-in-claude.sh" "$user" "$root/bin"
"$wire/seed/sandbox.sh" "$sandbox"
memory="$user/.claude/projects/$(echo "$sandbox/alpha" | tr '/.' '--')/memory"
mkdir -p "$memory"
cp "$wire/seed/project-memory/"*.md "$memory/"
"$tool" seed --home "$home" --sql "$wire/seed/state.sql" --var "sandbox=$sandbox"

PATH="$root/bin:$PATH" isolated "$user" "$tool" replay --recordings "$wire/recordings" --rules "$wire/normalize.toml" \
  --known "$wire/rust-differences.toml" --rust-home "$home" \
  --var "sandbox=$sandbox" --var "sandbox_slug=$(echo "$sandbox" | tr '/.' '--')" --var "home=$home" \
  --var "user_home=$user" --var "repo=$repo" \
  --var "api_origin=http://127.0.0.1:7500" --var "raw_origin=http://127.0.0.1:7501" "$@"
