#!/usr/bin/env bash
# Proves that the vendored crates are exactly "upstream + the patches in patches/":
#   vendor/model2vec-rs = model2vec-rs 0.4.0 + 0001
# The upstream crate is taken from cargo's registry, or fetched from crates.io (the public
# crate file; nothing of this repo is sent anywhere).
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

upstream() { # <crate> <version> -> prints the folder holding the pristine crate
  local name="$1-$2" cached
  cached="$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"$name" 2>/dev/null | head -1 || true)"
  if [ -n "$cached" ]; then echo "$cached"; return; fi
  curl -fsSL "https://static.crates.io/crates/$1/$name.crate" | tar -xz -C "$TMP"
  echo "$TMP/$name"
}

cp -R "$(upstream model2vec-rs 0.4.0)" "$TMP/model2vec-rs"
patch -s -p1 -d "$TMP/model2vec-rs" < patches/0001-model2vec-drop-duplicate-vocabulary.patch
diff -r -x .cargo-ok -x .cargo_vcs_info.json -x Cargo.lock -x '*.orig' -x '*.rej' "$TMP/model2vec-rs" vendor/model2vec-rs \
  || { echo "vendor/model2vec-rs is not upstream + patch 0001" >&2; exit 1; }
echo "patches ok"
