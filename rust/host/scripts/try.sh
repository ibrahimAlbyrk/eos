#!/bin/bash
# For the owner: the things only a person can check, on the test bundle (the release build
# with the dev guard, bundle.sh test). Everything runs on the private data copy; sending a
# message is refused by the dev guard. Nothing is notarized or uploaded; signing is local.
#
#   try.sh            open the app: drag the window by the top strip, double-click it, resize,
#                     ⌘C/⌘V/⌘Z in the composer and in a browser tab, full screen, close the
#                     window (the app stays in the Dock), click the Dock icon, ⌘Q
#   try.sh fresh      the same on a fresh shell profile
#   try.sh migrate    a fresh shell profile that carries localStorage over from a COPY of your
#                     Electron profile (the copy is made now; the original is only read)
#   try.sh banner     a test banner 6 seconds after launch: switch to another app, wait for it
#                     (with the Eos sound), click it → the Memory view opens
#   try.sh link       hand the running app an eos://pair/… link (opens the Connect sheet)
#   try.sh artifacts <claude.ai artifact link>
#                     the claude.ai sign-in window opens (profile of no Eos sign-in): sign in;
#                     then the artifact's live peek appears over the dashboard: hover-free
#                     check that it is a half-size miniature, click it (opens its side-panel
#                     tab, no reload), ⌥-click opens claude.ai in your browser, Reload in the
#                     tab swaps without a blank frame, ⌘C/⌘V inside the artifact, a link in
#                     it opens in your browser
#   try.sh status     the running app's state as JSON
#   try.sh build      rebuild the test bundle (after a change) and sign it; sets the
#                     checkout up first (scripts/setup.sh) when it is not
#   try.sh stop       quit the app
#
# claude.ai sign-in: in the app, open the side panel → Browser → claude.ai and sign in (also
# with Google). That view has its own profile and no bridge of any kind.
#
# EOS_BUNDLE_ID=… picks the bundle identifier (default dev.eos.shell: a first launch shows
# the system's own first-run prompts for a new app).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
source "$HERE/dev-env.sh"
OUT="$EOS_DEV_OUT"
APP="$EOS_HOST_WORK/bundle/test/Eos.app"
build() { require_setup 2>/dev/null || "$HERE/setup.sh"; "$HERE/bundle.sh" test >/dev/null; }
# The output is read whole first: grep -q leaving early would fail the pipe and sign again.
signed() { local said; said="$(codesign -dvv "$APP" 2>&1 || true)"; grep -q "^Authority=Developer ID" <<<"$said"; }
sign() { signed || "$HERE/sign.sh" "$APP" || echo "not signed (no Developer ID identity): running unsigned" >&2; }
ready() {
  [ -d "$APP" ] || build
  sign
}
case "${1:-run}" in
  status) "$HERE/ctl.sh" "$APP" --status; exit 0 ;;
  stop) "$HERE/ctl.sh" "$APP" --quit || true; exit 0 ;;
  link) "$HERE/ctl.sh" "$APP" "eos://pair/try-this-is-not-a-real-invite"; exit 0 ;;
  build) build; sign; exit 0 ;;
  run) ready; "$HERE/launch.sh" "$APP" ;;
  fresh) ready; rm -rf "$OUT/data"; "$HERE/launch.sh" "$APP" ;;
  migrate)
    ready
    SRC="$HOME/Library/Application Support/Eos/Local Storage"
    [ -d "$SRC" ] || { echo "no Electron profile at $SRC" >&2; exit 1; }
    COPY="$OUT/electron-profile-copy"
    rm -rf "$COPY" "$OUT/data"; mkdir -p "$COPY"
    cp -R "$SRC" "$COPY/Local Storage"
    EOS_ELECTRON_PROFILE="$COPY" "$HERE/launch.sh" "$APP"
    echo "carried over from the copy at $COPY; see $OUT/data/migrated-from-electron.json" ;;
  banner)
    ready
    STEPS="$OUT/banner-steps.json"
    echo '[{"wait": 6000}, {"notify": {"title": "Eos", "body": "A test banner. Click it: the Memory view opens.", "route": "memory"}}]' > "$STEPS"
    EOS_DEV_SCRIPT="$STEPS" EOS_DEV_SCRIPT_OUT="$OUT/banner-out.json" "$HERE/launch.sh" "$APP"
    echo "switch to another app now; the banner comes in 6 seconds" ;;
  artifacts)
    LINK="${2:?usage: try.sh artifacts <claude.ai artifact link>}"
    ready
    STEPS="$OUT/artifacts-steps.json"
    REF="{\"url\": \"$LINK\", \"loginId\": null}"
    printf '[{"wait": 4000}, {"artifacts": {"verb": "signIn", "body": {"loginId": null}}}, {"artifacts": {"verb": "peek", "body": {"ref": %s, "rect": {"x": 360, "y": 120, "width": 420, "height": 300}}}}]' "$REF" > "$STEPS"
    EOS_DEV_SCRIPT="$STEPS" EOS_DEV_SCRIPT_OUT="$OUT/artifacts-out.json" "$HERE/launch.sh" "$APP"
    echo "sign in to claude.ai in the window that opens; the artifact's peek follows" ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
