#!/usr/bin/env bash
# Writes sample data of every Eos area into the state.db of a dev data copy, for the Eos screens
# in a dev run: routines with versions, runs and a day of spend, signals, a Needs-you item of
# every kind, notes, a mail routine whose view has three issues, and a capability in each state.
#
#   eos-sample.sh <copy>
#
# Refuses ~/.eos and anything inside it, and a folder without state.db. Running it again on the
# same copy adds nothing.
set -euo pipefail

copy="$(cd "${1:?data copy}" && pwd -P)"
cd "$(dirname "$0")/.."
exec cargo xtask sample "$copy"
