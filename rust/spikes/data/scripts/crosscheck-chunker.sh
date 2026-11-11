#!/bin/bash
# Chunks real files with the Rust and the TypeScript chunker and compares cut
# points and chunk ids. Usage: scripts/crosscheck-chunker.sh [file...]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_INCREMENTAL=0
cargo build -q --release -p spike-update
files=("$@")
[ ${#files[@]} -eq 0 ] && files=(/bin/ls /bin/zsh /usr/bin/ssh "$(command -v node)" "$HOME/.cargo/bin/cargo" /usr/share/dict/words /dev/null)
fail=0
for f in "${files[@]}"; do
  rust=$(target/release/chunk-file "$f" | shasum -a 256 | cut -c1-16)
  ts=$(node ts/chunk-file.ts "$f" | shasum -a 256 | cut -c1-16)
  chunks=$(target/release/chunk-file "$f" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["lengths"]))')
  size=$(stat -L -f %z "$f")
  if [ "$rust" = "$ts" ]; then echo "same  $size bytes  $chunks chunks  $f"; else echo "DIFF  $f"; fail=1; fi
done
exit $fail
