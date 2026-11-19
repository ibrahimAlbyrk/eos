#!/usr/bin/env bash
# Writes sample routines (PR Review, Morning Paper, Release Notes, with versions, finished runs
# and a day of spend) into the state.db of a dev data copy, for the Eos screens in a dev run.
#
#   eos-sample.sh <copy>
#
# Refuses ~/.eos and anything inside it, and a folder without state.db. Running it again on the
# same copy adds nothing.
set -euo pipefail

copy="$(cd "${1:?data copy}" && pwd -P)"
cd "$(dirname "$0")/.."
exec cargo xtask sample "$copy"
