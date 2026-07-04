#!/usr/bin/env bash
# Render the real assembled orchestrator/worker system prompt offline (no daemon).
# See preview-prompt.mts for usage. Thin wrapper: runs the .mts via tsx.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec npx tsx "$ROOT/scripts/preview-prompt.mts" "$@"
