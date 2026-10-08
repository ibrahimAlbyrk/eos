#!/usr/bin/env bash
# Replay past keep/dismiss decisions on dream proposals through today's writing rules
# and critic. See dream-eval.mts for usage. Thin wrapper: runs the .mts via tsx.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec npx tsx "$ROOT/scripts/dream-eval.mts" "$@"
