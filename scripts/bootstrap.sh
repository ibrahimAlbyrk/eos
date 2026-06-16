#!/usr/bin/env bash
# bootstrap.sh — install every package dir in dependency order (NOT a workspace)
set -euo pipefail

src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" != /* ]] && src="$dir/$src"
done
ROOT="$(cd -P "$(dirname "$src")/.." && pwd)"

# Order matters: core/infra use file: deps on contracts/core.
PACKAGES=(contracts core infra gateway spawner manager app/ui .)

for pkg in "${PACKAGES[@]}"; do
  echo "==> installing $pkg"
  (cd "$ROOT/$pkg" && npm install)
done

if [[ "${1:-}" == "--link" ]]; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$ROOT/manager/bin/eos" "$HOME/.local/bin/eos"
  echo "==> linked $HOME/.local/bin/eos -> $ROOT/manager/bin/eos"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "note: $HOME/.local/bin is not on PATH — add it to use 'eos'." ;;
  esac
fi

echo "==> bootstrap complete"
