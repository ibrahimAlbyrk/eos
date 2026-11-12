#!/usr/bin/env bash
# Records or replays the wire fixtures against today's Node daemon, run in
# isolation (scripts/wire-daemon.sh). See fixtures/README.md.
#
#   wire.sh record                 synthetic data folder → fixtures/wire/recordings (+ routes.json, coverage.md)
#   wire.sh replay                 a second fresh synthetic folder, diffed against those recordings
#   wire.sh record-private <copy>  read-only scenarios (and scenarios-private) on a copy of a real data
#                                  folder made by private-copy.sh → fixtures/private
#   wire.sh replay-private <copy>  the same copy again, diffed against fixtures/private
#   wire.sh up | down              a seeded synthetic daemon that stays up, for writing scenarios;
#                                  EOS_WIRE_REUSE=1 wire.sh record|replay then runs against it
#
# Extra arguments go to wire-recorder (e.g. --only pages,profile --verbose).
# EOS_WIRE_RUN  where run folders are made (default $TMPDIR/eos-wire; keep it short: unix socket paths)
set -euo pipefail

mode="${1:?record|replay|record-private|replay-private|up|down}"
shift
rust="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(dirname "$rust")"
wire="$rust/fixtures/wire"
root="${EOS_WIRE_RUN:-${TMPDIR:-/tmp}/eos-wire}"
mkdir -p "$root"
root="$(cd "$root" && pwd -P)"
port="${EOS_WIRE_PORT:-7500}"
raw_port="${EOS_WIRE_RAW_PORT:-7501}"

recorder() {
  cargo run --quiet --manifest-path "$rust/Cargo.toml" -p wire-recorder -- "$@"
}

# A synthetic run's `claude`: the compiled stand-in (crates/eos-mod-terminals/examples/
# fake_claude.rs), so a Claude pane runs it and never a real Claude Code. Never given to a
# run on a copy of real data.
stand_in_claude() {
  cargo build --quiet --manifest-path "$rust/Cargo.toml" -p eos-mod-terminals --example fake_claude
  mkdir -p "$root/bin"
  ln -sf "$rust/target/debug/examples/fake_claude" "$root/bin/claude"
  export PATH="$root/bin:$PATH"
}

target() {
  local home="$1"
  echo --api "http://127.0.0.1:$port" --raw "http://127.0.0.1:$raw_port" --socket "$home/daemon.sock" \
    --token-file "$home/ui-token" --rules "$wire/normalize.toml"
}

# A fresh synthetic data folder: invented projects, invented rows, nothing of the user's.
synthetic() {
  local run="$1" home="$1/home" user="$1/user" sandbox="$1/sandbox"
  # A daemon left on this folder by an earlier run would keep the port.
  "$rust/scripts/wire-daemon.sh" stop "$home"
  rm -rf "$run"
  mkdir -p "$home" "$user"
  cp -R "$wire/seed/home/." "$home/"
  cp -R "$wire/seed/user/." "$user/"
  "$rust/scripts/stand-in-claude.sh" "$user" "$root/bin"
  "$wire/seed/sandbox.sh" "$sandbox"
  # Claude Code's own file memory for the alpha project, where the daemon looks for it.
  local memory
  memory="$user/.claude/projects/$(echo "$sandbox/alpha" | tr '/.' '--')/memory"
  mkdir -p "$memory"
  cp "$wire/seed/project-memory/"*.md "$memory/"
  # The first boot creates the schema; rows go in while no daemon runs, so the
  # next boot meets them as it would after a crash.
  "$rust/scripts/wire-daemon.sh" start "$home" >/dev/null
  "$rust/scripts/wire-daemon.sh" stop "$home"
  sed "s|{sandbox}|$sandbox|g" "$wire/seed/state.sql" | sqlite3 "$home/state.db"
}

case "$mode" in
  up)
    stand_in_claude
    synthetic "$root/dev"
    "$rust/scripts/wire-daemon.sh" start "$root/dev/home" >/dev/null
    echo "up: $root/dev (stop it with: wire.sh down)"
    ;;
  down)
    "$rust/scripts/wire-daemon.sh" stop "$root/dev/home"
    ;;
  record | replay)
    stand_in_claude
    run="$root/$mode"
    [ -n "${EOS_WIRE_REUSE:-}" ] && run="$root/dev"
    home="$run/home"
    if [ -z "${EOS_WIRE_REUSE:-}" ]; then
      synthetic "$run"
      trap '"$rust/scripts/wire-daemon.sh" stop "$home"' EXIT
    fi
    start() {
      [ -n "${EOS_WIRE_REUSE:-}" ] || "$rust/scripts/wire-daemon.sh" start "$home" >/dev/null
    }
    vars=(--var "sandbox=$run/sandbox" --var "sandbox_slug=$(echo "$run/sandbox" | tr '/.' '--')" --var "home=$home" \
      --var "user_home=$run/user" --var "repo=$repo" \
      --var "api_origin=http://127.0.0.1:$port" --var "raw_origin=http://127.0.0.1:$raw_port")
    if [ "$mode" = record ]; then
      EOS_WIRE_ROUTES_OUT="$wire/routes.json" start
      # shellcheck disable=SC2046
      recorder record --scenarios "$wire/scenarios" --out "$wire/recordings" --routes "$wire/routes.json" \
        $(target "$home") "${vars[@]}" "$@"
      recorder coverage --routes "$wire/routes.json" --recordings "$wire/recordings" \
        --notes "$wire/not-recordable.toml" --out "$wire/coverage.md" || true
    else
      start
      # shellcheck disable=SC2046
      recorder replay --recordings "$wire/recordings" $(target "$home") "${vars[@]}" "$@"
    fi
    ;;
  record-private | replay-private)
    home="$(cd "${1:?a copy of a real data folder}" && pwd -P)"
    shift
    out="$rust/fixtures/private"
    user="$root/private-user"
    mkdir -p "$out" "$user"
    # The copy holds real chats: the recorder sends only reads to a folder so marked.
    touch "$home/REAL_DATA"
    vars=(--real-data --var "home=$home" --var "user_home=$user" --var "repo=$repo")
    # A copy made by private-copy.sh holds its project folders in <copy>-sb.
    [ -d "$home-sb" ] && vars+=(--var "sandbox=$home-sb" --var "sandbox_slug=$(echo "$home-sb" | tr '/.' '--')" --var "home_slug=$(echo "$home" | tr '/.' '--')")
    # The chats and records the private scenarios read, picked from the copy.
    # Picked before the boot, as replay.sh picks them on its copy.
    while read -r flag value; do vars+=("$flag" "$value"); done < <("$rust/scripts/private-vars.sh" "$home")
    trap '"$rust/scripts/wire-daemon.sh" stop "$home"' EXIT
    EOS_WIRE_USER_HOME="$user" "$rust/scripts/wire-daemon.sh" start "$home" >/dev/null
    if [ "$mode" = record-private ]; then
      for scenarios in "$wire/scenarios" "$wire/scenarios-private"; do
        # shellcheck disable=SC2046
        recorder record --scenarios "$scenarios" --out "$out" --routes "$wire/routes.json" \
          --read-only --lenient $(target "$home") "${vars[@]}" "$@"
      done
    else
      # shellcheck disable=SC2046
      recorder replay --recordings "$out" $(target "$home") "${vars[@]}" "$@"
    fi
    ;;
  *)
    echo "usage: wire.sh record|replay|record-private <copy>|replay-private <copy>|up|down" >&2
    exit 1
    ;;
esac
