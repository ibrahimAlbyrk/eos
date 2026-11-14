#!/usr/bin/env bash
# Builds both workspaces against a local checkout of the agent engine instead of the commit
# pinned in Cargo.toml, by writing the git-ignored .cargo/local-sdk.toml (a [patch] that
# .cargo/config.toml includes when it exists).
#
#   scripts/local-sdk.sh <engine checkout>   use that checkout
#   scripts/local-sdk.sh --off               back to the pinned commit
#   scripts/local-sdk.sh                     say which one is used
#
# While it is on, Cargo.lock and host/Cargo.lock name the local crates: commit neither.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="https://github.com/ibrahimAlbyrk/eos-agent-sdk"
file=".cargo/local-sdk.toml"

case "${1:-}" in
  "")
    if [[ -f "$file" ]]; then
      echo "local-sdk: building against $(sed -n 's/^# checkout: //p' "$file")"
    else
      echo "local-sdk: building against the pinned commit ($repo)"
    fi
    ;;
  --off)
    rm -f "$file"
    echo "local-sdk: off; building against the pinned commit again"
    ;;
  -*)
    echo "usage: scripts/local-sdk.sh [<engine checkout> | --off]" >&2
    exit 2
    ;;
  *)
    [[ -d "$1" ]] || { echo "local-sdk: no folder $1" >&2; exit 1; }
    checkout="$(cd "$1" && pwd)"
    {
      echo "# Written by scripts/local-sdk.sh; remove with scripts/local-sdk.sh --off."
      echo "# checkout: $checkout"
      echo "[patch.\"$repo\"]"
      # Every engine crate Cargo.toml names, found in the checkout by its package name.
      for name in $(sed -n 's/^\(eos-agent-[a-z-]*\) = { git = .*/\1/p' Cargo.toml); do
        manifest="$(grep -l "^name = \"$name\"" "$checkout"/crates/*/Cargo.toml "$checkout"/tools/*/Cargo.toml 2>/dev/null | head -1)"
        [[ -n "$manifest" ]] || { echo "local-sdk: $checkout has no crate $name" >&2; rm -f "$file.part"; exit 1; }
        echo "$name = { path = \"$(dirname "$manifest")\" }"
      done
    } > "$file.part"
    mv "$file.part" "$file"
    echo "local-sdk: building against $checkout (scripts/local-sdk.sh --off to stop)"
    ;;
esac
