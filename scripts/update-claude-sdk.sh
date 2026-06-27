#!/usr/bin/env bash
# update-claude-sdk.sh — keep the bundled Claude Code SDK current on the 0.3.x line.
#
# Eos drives Claude Code through @anthropic-ai/claude-agent-sdk, pinned in
# manager/ (NOT a workspace — all npm work happens there). The npm package
# ships the JS wrapper AND its platform binary versioned in lockstep, so the
# only safe mechanism is to bump the npm pin and keep bundling — never point at
# an external binary (wrapper↔binary skew). This script automates that bump,
# gated on the manager test suite.
#
# What it does:
#   1. Resolves the latest published 0.3.x from npm.
#   2. No-op (exit 0) if manager/package-lock.json already resolves it.
#   3. Otherwise bumps package.json floor to ^<latest>, installs, runs
#      `cd manager && npm test`.
#      - PASS: keeps the change, prints the new version, exit 0.
#      - FAIL: restores package.json + package-lock.json to their prior state,
#        exit 1 with the failing context.
#   Idempotent: safe to run repeatedly; only acts when behind.
#
# Run it:
#   bash scripts/update-claude-sdk.sh
#
# Schedule it (opt-in — this script does NOT install any agent itself):
#   cron (weekly, Mon 04:00):
#     0 4 * * 1 cd /Users/ibrahimalbyrk/Projects/CC/eos && bash scripts/update-claude-sdk.sh >> ~/.eos/sdk-update.log 2>&1
#   launchd: wrap the same command in a LaunchAgent plist with StartCalendarInterval.
#
# NOTE: a successful bump only takes effect on the operator's next deliberate
# `eos restart` — this script never restarts the daemon (that crashes running
# workers).
set -euo pipefail

PKG="@anthropic-ai/claude-agent-sdk"
MAJOR_MINOR="0.3"

src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" != /* ]] && src="$dir/$src"
done
ROOT="$(cd -P "$(dirname "$src")/.." && pwd)"
MANAGER="$ROOT/manager"

latest="$(npm view "$PKG" versions --json 2>/dev/null \
  | jq -r --arg mm "$MAJOR_MINOR" \
      '[.[] | select(startswith($mm + "."))] | sort_by(split(".") | map(tonumber)) | last')"
if [ -z "$latest" ] || [ "$latest" = "null" ]; then
  echo "error: could not resolve latest $MAJOR_MINOR.x for $PKG from npm" >&2
  exit 1
fi

current="$(jq -r --arg p "node_modules/$PKG" '.packages[$p].version // ""' "$MANAGER/package-lock.json")"
if [ -z "$current" ]; then
  echo "error: could not read locked $PKG version from $MANAGER/package-lock.json" >&2
  exit 1
fi

if [ "$current" = "$latest" ]; then
  echo "already current: $PKG @ $current (latest $MAJOR_MINOR.x) — no-op"
  exit 0
fi

echo "bumping $PKG: $current -> $latest"

backup="$(mktemp -d)"
cp "$MANAGER/package.json" "$backup/package.json"
cp "$MANAGER/package-lock.json" "$backup/package-lock.json"

restore() {
  echo "reverting $MANAGER/package.json + package-lock.json to prior state" >&2
  cp "$backup/package.json" "$MANAGER/package.json"
  cp "$backup/package-lock.json" "$MANAGER/package-lock.json"
  (cd "$MANAGER" && npm install >/dev/null 2>&1) || true
}

# Bump the floor in package.json to document the new baseline, then install.
tmp="$(mktemp)"
jq --arg p "$PKG" --arg v "^$latest" '.dependencies[$p] = $v' "$MANAGER/package.json" > "$tmp"
mv "$tmp" "$MANAGER/package.json"

if ! (cd "$MANAGER" && npm install); then
  restore
  rm -rf "$backup"
  echo "FAILED: npm install errored for $PKG@$latest — reverted, staying on $current" >&2
  exit 1
fi

if ! (cd "$MANAGER" && npm test); then
  restore
  rm -rf "$backup"
  echo "FAILED: manager test gate failed on $PKG@$latest — reverted, staying on $current" >&2
  exit 1
fi

rm -rf "$backup"
echo "OK: $PKG updated $current -> $latest (manager test gate passed)"
echo "note: takes effect on the operator's next 'eos restart'"
exit 0
