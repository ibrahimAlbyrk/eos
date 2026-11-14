#!/usr/bin/env bash
# Links the agent engine's checkout at vendor/eos-agent-sdk, where the workspace
# manifest expects it, and checks that it holds the commit this tree needs (SDK_REV).
#
#   scripts/link-sdk.sh           create or repair the link, then check it
#   scripts/link-sdk.sh --check   only check (what scripts/check.sh runs first)
#
# The checkout is $EOS_AGENT_SDK when set, else the folder `eos-agent-sdk` beside
# the main checkout of this repository (the same place from every worktree).
set -euo pipefail
cd "$(dirname "$0")/.."

link="vendor/eos-agent-sdk"
want="$(tr -d '[:space:]' < SDK_REV)"

fail() {
  echo "link-sdk: $1" >&2
  exit 1
}

if [[ "${1:-}" != "--check" ]]; then
  if [[ -n "${EOS_AGENT_SDK:-}" ]]; then
    target="$EOS_AGENT_SDK"
  else
    target="$(cd "$(git rev-parse --git-common-dir)/../.." && pwd)/eos-agent-sdk"
  fi
  [[ -f "$target/crates/eos-agent-sdk/Cargo.toml" ]] ||
    fail "no eos-agent-sdk checkout at $target (set EOS_AGENT_SDK to one)"
  target="$(cd "$target" && pwd)"
  mkdir -p vendor
  if [[ -L "$link" || ! -e "$link" ]]; then
    ln -sfn "$target" "$link"
  else
    fail "$link exists and is not a link; remove it first"
  fi
  echo "link-sdk: $link -> $target"
fi

[[ -f "$link/crates/eos-agent-sdk/Cargo.toml" ]] ||
  fail "$link is missing: run scripts/link-sdk.sh (the agent engine is a checkout beside this repository)"
git -C "$link" merge-base --is-ancestor "$want" HEAD 2>/dev/null ||
  fail "the eos-agent-sdk checkout at $(cd "$link" && pwd -P) does not contain commit $want (SDK_REV): update it, or point EOS_AGENT_SDK at one that does and run scripts/link-sdk.sh"
