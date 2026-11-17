#!/usr/bin/env bash
# Checks only what a change touches: seconds to a few minutes, where scripts/check.sh checks
# everything and takes about twenty. Every part runs even when an earlier one fails.
#
#   test.sh                  what the working tree changed since the last commit
#   test.sh --since <ref>    what changed since that commit, uncommitted work included
#   test.sh eos-app …        these crates as well: the ones the change is likely to break
#
# A changed crate gets fmt, clippy (warnings are errors) and its tests. The dashboard gets the
# tests related to its changed files, and lint on them. The relay gets its tests. Changed paths
# that nothing here checks are listed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

since=HEAD
crates=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="${2:?--since needs a commit}"; shift 2 ;;
    -*) echo "usage: scripts/test.sh [--since <ref>] [crate …]" >&2; exit 2 ;;
    *) crates="$crates $1"; shift ;;
  esac
done

ui="" lint="" relay="" unchecked="" status=0
while IFS= read -r path; do
  case "$path" in
    crates/*/*) crate="${path#crates/}"; crates="$crates ${crate%%/*}" ;;
    tools/wire-recorder/*) crates="$crates wire-recorder" ;;
    xtask/*) crates="$crates xtask" ;;
    app/ui/src/*)
      if [ -f "$path" ]; then
        ui="$ui ${path#app/ui/}"
        case "$path" in *.js | *.jsx | *.ts) lint="$lint ${path#app/ui/}" ;; esac
      fi
      ;;
    relay/*) relay=yes ;;
    *.md) ;;
    ?*) unchecked="$unchecked $path" ;;
  esac
done < <({ git diff --name-only "$since"; git ls-files --others --exclude-standard; } | sort -u)
crates="$(printf '%s\n' $crates | sort -u | tr '\n' ' ')"

# Test programs and incremental caches fill most of the build folder and are quick to make
# again: the ones no build has written for three days go, once a day.
prune_build_folder() {
  [ -d target/debug ] || return 0
  [ -z "$(find target/.pruned -mtime -1 2>/dev/null)" ] || return 0
  find target/debug/incremental -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null || true
  find target/debug/deps -maxdepth 1 -type f -perm +111 ! -name '*.*' -mtime +3 -delete 2>/dev/null || true
  touch target/.pruned
}

if [ -n "${crates// /}" ]; then
  echo "== crates: $crates"
  packages=""
  for crate in $crates; do packages="$packages -p $crate"; done
  # With sccache installed, a new worktree takes the crates from outside this repository out of
  # the machine's shared cache instead of compiling them again.
  if command -v sccache >/dev/null; then export RUSTC_WRAPPER=sccache; fi
  prune_build_folder
  cargo fmt --check $packages || status=1
  cargo clippy $packages --all-targets --quiet -- -D warnings || status=1
  cargo test $packages --no-fail-fast --quiet || status=1
fi

if [ -n "$ui" ]; then
  echo "== dashboard:$ui"
  (cd app/ui && npx vitest related --run $ui) || status=1
  if [ -n "$lint" ]; then (cd app/ui && npx eslint $lint) || status=1; fi
fi

if [ -n "$relay" ]; then
  echo "== relay"
  (cd relay && npm test) || status=1
fi

if [ -n "$unchecked" ]; then
  echo "== not checked here:"
  printf '   %s\n' $unchecked
fi
exit $status
