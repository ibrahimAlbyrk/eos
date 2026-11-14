#!/bin/bash
# Proves that the vendored code is exactly "upstream + the patches in patches/":
#   vendor/tauri-runtime-cef   = tauri-runtime-cef 3.0.0-alpha.7 + 0001 + 0003 + 0004
#   cef-helper/src/main.rs     = tauri-bundler 3.0.0-alpha.5 cef-helper/main.rs + 0002
# The upstream crates are taken from cargo's registry cache, or fetched from crates.io (the
# public crate files; nothing of this repo is sent anywhere).
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$HOST_DIR"
PRISTINE="$EOS_HOST_WORK/pristine"
mkdir -p "$PRISTINE"

upstream() { # <crate> <version> -> prints the folder holding the pristine crate
  local name="$1-$2" cached
  cached="$(ls -d "$CARGO_HOME"/registry/src/*/"$name" 2>/dev/null | head -1 || true)"
  if [ -n "$cached" ]; then echo "$cached"; return; fi
  if [ ! -d "$PRISTINE/$name" ]; then
    curl -fsSL "https://static.crates.io/crates/$1/$name.crate" | tar -xz -C "$PRISTINE"
  fi
  echo "$PRISTINE/$name"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

RUNTIME="$(upstream tauri-runtime-cef 3.0.0-alpha.7)"
cp -R "$RUNTIME" "$TMP/runtime"
for p in patches/0001-runtime-no-bridge.patch patches/0003-runtime-launch-without-activation.patch \
         patches/0004-runtime-contained-popups.patch; do
  patch -s -p1 -d "$TMP/runtime" < "$p"
done
diff -r -x .cargo-ok -x .cargo_vcs_info.json -x Cargo.lock -x '*.orig' -x '*.rej' "$TMP/runtime" vendor/tauri-runtime-cef \
  || { echo "vendor/tauri-runtime-cef is not upstream + patches 0001, 0003 and 0004" >&2; exit 1; }

BUNDLER="$(upstream tauri-bundler 3.0.0-alpha.5)"
cp "$BUNDLER/cef-helper/main.rs" "$TMP/main.rs"
patch -s "$TMP/main.rs" < patches/0002-cef-helper-no-bridge.patch
diff "$TMP/main.rs" cef-helper/src/main.rs \
  || { echo "cef-helper/src/main.rs is not upstream + patch 0002" >&2; exit 1; }
echo "patches ok"
