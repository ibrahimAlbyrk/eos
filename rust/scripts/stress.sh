#!/usr/bin/env bash
# Runs test suites over and over, optionally while other processes keep every
# core busy, to bring out what only fails now and then.
#
#   stress.sh [-n RUNS] [-l BUSY] [-p PACKAGE]... [-- TEST ARGS]
#
#   -n RUNS     how many times each test binary runs (default 20)
#   -l BUSY     CPU-bound processes to run alongside (default 0; e.g. the number of cores)
#   -p PACKAGE  a package whose tests run (repeatable; default: the sessions and stream
#               suites — eos-sessions, eos-runtime, eos-app, eos-mod-agents, eos-kit-fs,
#               eos-kit-sqlite, eos-mod-terminals)
#   TEST ARGS   passed to every test binary (e.g. a name filter, --ignored)
#
# Each failing run's output is kept under $TMPDIR/eos-stress/; the summary
# lists failures per binary and test. Exit 1 when any run failed. The busy
# processes are this script's own children and stop with it.
set -euo pipefail
cd "$(dirname "$0")/.."

runs=20
busy=0
packages=()
while [ $# -gt 0 ]; do
  case "$1" in
    -n) runs="$2"; shift 2 ;;
    -l) busy="$2"; shift 2 ;;
    -p) packages+=("$2"); shift 2 ;;
    --) shift; break ;;
    *) echo "stress.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ ${#packages[@]} -gt 0 ] ||
  packages=(eos-sessions eos-runtime eos-app eos-mod-agents eos-kit-fs eos-kit-sqlite eos-mod-terminals)
logs="${TMPDIR:-/tmp}/eos-stress"
rm -rf "$logs"
mkdir -p "$logs"

args=()
for p in "${packages[@]}"; do args+=(-p "$p"); done
binaries=$(cargo test --no-run --message-format=json "${args[@]}" 2>/dev/null |
  python3 -c 'import json, sys
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if m.get("reason") == "compiler-artifact" and m.get("executable") and m.get("profile", {}).get("test"):
        print(m["executable"])' | sort -u)
[ -n "$binaries" ] || { echo "stress.sh: no test binaries were built" >&2; exit 1; }

burners=()
stop_burners() {
  for pid in "${burners[@]+"${burners[@]}"}"; do kill "$pid" 2>/dev/null || true; done
}
trap stop_burners EXIT
trap 'stop_burners; exit 1' INT TERM
for _ in $(seq 1 "$busy"); do
  (while :; do :; done) &
  burners+=($!)
done

failed=0
for bin in $binaries; do
  name="$(basename "$bin")"
  bad=0
  for run in $(seq 1 "$runs"); do
    if ! "$bin" --quiet "$@" >"$logs/$name.$run.log" 2>&1; then
      bad=$((bad + 1))
      grep -E "^    [a-z_:0-9]+$|panicked at" "$logs/$name.$run.log" | head -5 | sed "s/^/  $name run $run: /"
    else
      rm -f "$logs/$name.$run.log"
    fi
  done
  if [ "$bad" -gt 0 ]; then
    failed=1
    echo "$name: $bad of $runs runs failed (logs in $logs)"
  else
    echo "$name: $runs of $runs runs passed"
  fi
done
exit "$failed"
