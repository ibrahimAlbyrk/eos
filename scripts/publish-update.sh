#!/usr/bin/env bash
# See publish-update.mts for usage. Thin wrapper: runs the .mts via tsx.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec npx tsx "$ROOT/scripts/publish-update.mts" "$@"
