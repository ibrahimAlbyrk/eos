#!/bin/bash
# Spike 9. Everything happens in a throwaway keychain file that is created
# here and deleted at the end; the login keychain is never opened. Reads from
# the Rust probe run with user interaction off, so nothing can pop up.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" CARGO_INCREMENTAL=0
cargo build -q --release -p spike-keychain || exit 1

work=$(mktemp -d)
kc="$work/eos-rs-spike.keychain-db"
pw=spike
before=$(security list-keychains -d user)
cleanup() {
  security delete-keychain "$kc" 2>/dev/null
  # create-keychain must not have changed the user's search list; put it back if it did.
  [ "$(security list-keychains -d user)" = "$before" ] || echo "$before" | xargs security list-keychains -d user -s
  rm -rf "$work"
}
trap cleanup EXIT

security create-keychain -p "$pw" "$kc"
security set-keychain-settings "$kc"
security unlock-keychain -p "$pw" "$kc"
[ "$(security list-keychains -d user)" = "$before" ] && echo "search list untouched" || echo "search list changed (restored at exit)"

# The probe in three signing states.
cp target/release/spike-keychain "$work/probe-linker"                      # as cargo built it: ad hoc, linker-signed
cp target/release/spike-keychain "$work/probe-adhoc"
codesign -f -s - -i dev.eos-spike.keychain "$work/probe-adhoc" 2>/dev/null   # ad hoc with a fixed identifier
cp target/release/spike-keychain "$work/probe-update"
printf 'x' >> "$work/probe-update"                                         # "the next build": other bytes, same identifier
codesign -f -s - -i dev.eos-spike.keychain "$work/probe-update" 2>/dev/null
cp target/release/spike-keychain "$work/probe-unsigned"
codesign --remove-signature "$work/probe-unsigned" 2>/dev/null

secret=$(openssl rand -hex 16)
security add-generic-password -s eos-rs-spike-cli -a dummy -w "$secret" "$kc"            # default ACL: the creating tool
security add-generic-password -A -s eos-rs-spike-any -a dummy -w "$secret" "$kc"         # -A: any application
security add-generic-password -T "$work/probe-adhoc" -s eos-rs-spike-trusted -a dummy -w "$secret" "$kc"

echo "--- /usr/bin/security reads its own item (20 runs)"
python3 - "$kc" <<'PY'
import subprocess, sys, time
ts = []
for _ in range(20):
    t = time.perf_counter()
    r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", "eos-rs-spike-cli", "-a", "dummy", "-w", sys.argv[1]], capture_output=True)
    ts.append((time.perf_counter() - t) * 1000)
ts.sort()
print(f"  exit {r.returncode}, {len(r.stdout.strip())} bytes, median {ts[10]:.1f} ms, max {ts[-1]:.1f} ms")
PY

for item in eos-rs-spike-cli eos-rs-spike-any eos-rs-spike-trusted; do
  echo "--- item $item"
  for probe in probe-linker probe-adhoc probe-update probe-unsigned; do
    printf '  %-15s ' "$probe"; "$work/$probe" read "$kc" "$pw" "$item" dummy 2>&1 | tail -1
  done
done

echo "--- an item the probe creates itself"
"$work/probe-adhoc" add "$kc" "$pw" eos-rs-spike-own dummy
for probe in probe-adhoc probe-update probe-linker; do
  printf '  %-15s ' "$probe"; "$work/$probe" read "$kc" "$pw" eos-rs-spike-own dummy 2>&1 | tail -1
done

echo "--- who each item trusts (ACL of the dummy items; no values)"
security dump-keychain -a "$kc" 2>/dev/null | awk '
  /"svce"<blob>=/ { svc=$0; sub(/.*=/, "", svc) }
  /entry [0-9]+:/ { entry=$0 }
  /authorizations/ { auth=$0; sub(/.*authorizations \([0-9]+\): /, "", auth) }
  /applications/ { apps=$0; sub(/^ */, "", apps); print "  " svc " | " auth " | " apps }
  /^ +[0-9]+: \// { path=$0; sub(/^ +[0-9]+: /, "", path); sub(/ \(.*/, "", path); n=split(path, p, "/"); print "      trusted: " p[n] }
'

echo "--- data-protection keychain from a binary without entitlements"
printf '  %-15s ' probe-adhoc; "$work/probe-adhoc" dp-add eos-rs-spike-dp dummy
