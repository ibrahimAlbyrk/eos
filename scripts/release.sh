#!/usr/bin/env bash
# release.sh — build, sign, notarize and publish Eos.app as a GitHub release.
#
#   bash scripts/release.sh <version>        e.g. bash scripts/release.sh 0.1.0
#
# Needs, on this Mac only: the "Developer ID Application" cert in the keychain and
# the notarytool keychain profile `eos-notary` (app/README.md › Signing). Other Macs
# install the published zip through install.sh — they never build or sign.
#
# Steps: bump app/package.json + the iPhone app's version → `npm run make` with
# EOS_NOTARIZE=1 (sign + notarize + staple) and EOS_UPDATE_CHANNEL=stable (marks it
# a release build that updates itself) → check Gatekeeper accepts it → commit +
# tag v<version> → push → `gh release create` with Eos-darwin-arm64.zip (the fixed
# name install.sh downloads from releases/latest) and the iPhone app's source →
# publish the same Eos.app to the in-app update feed (scripts/publish-update.sh).
# Title and body come from docs/release/notes/v<version>.md, written by the rules in
# docs/release/00-RELEASE-NOTES.md. The Windows workflow attaches its builds once
# the release is published.
set -euo pipefail

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <major.minor.patch>" >&2; exit 1; }
tag="v$version"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
PROFILE="${EOS_NOTARY_PROFILE:-eos-notary}"
NOTES="$ROOT/docs/release/notes/$tag.md"

die() { echo "error: $*" >&2; exit 1; }

# Everything that can fail cheaply is checked before the long build.
[ "$(uname -m)" = "arm64" ] || die "releases are built on Apple Silicon (the app is arm64-only)"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || die "working tree is not clean"
git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"
security find-identity -v -p codesigning | grep -q '"Developer ID Application: ' \
  || die "no Developer ID Application certificate in the keychain"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || die "notarytool profile '$PROFILE' is missing — see app/README.md › Signing"
gh auth status >/dev/null 2>&1 || die "gh is not signed in (gh auth login)"
security find-generic-password -s eos-update-signing >/dev/null 2>&1 || [ -n "${EOS_UPDATE_SIGNING_KEY:-}" ] \
  || die "no update signing key (Keychain eos-update-signing) — see docs/updates/00-UPDATES-PLAN.md"
[ -f "$NOTES" ] || die "no release notes at ${NOTES#$ROOT/} — write them from docs/release/00-RELEASE-NOTES.md"
title="$(head -1 "$NOTES" | sed -E 's/^# +//')"
[[ "$title" == "Eos $version — "* ]] || die "the notes' first line must be '# Eos $version — <theme>'"

# A failed build must not leave the version bump behind.
trap 'git -C "$ROOT" checkout -q -- app/package.json app/package-lock.json ios/project.yml' EXIT

(cd "$APP" && npm version "$version" --no-git-tag-version >/dev/null)
sed -i '' -E "s/^( *MARKETING_VERSION: ).*/\1\"$version\"/" "$ROOT/ios/project.yml"
(cd "$APP" && EOS_NOTARIZE=1 EOS_UPDATE_CHANNEL=stable npm run make)

built="$APP/out/Eos-darwin-arm64/Eos.app"
spctl -a -vv "$built" 2>&1 | grep -q "source=Notarized Developer ID" \
  || die "Gatekeeper does not accept $built as notarized"
xcrun stapler validate "$built" >/dev/null || die "the notarization ticket is not stapled to $built"

asset="$APP/out/make/Eos-darwin-arm64.zip"
cp "$APP/out/make/zip/darwin/arm64/Eos-darwin-arm64-$version.zip" "$asset"

git -C "$ROOT" commit -qm "release: $tag" -- app/package.json app/package-lock.json ios/project.yml
git -C "$ROOT" tag "$tag"

# Eos Remote has no store build: its source at this tag, built with BUILD.md.
ios_asset="$APP/out/make/Eos-Remote-iOS-source.zip"
git -C "$ROOT" archive --format=zip --prefix=eos-remote/ -o "$ios_asset" "$tag" ios

git -C "$ROOT" push -q origin HEAD "$tag"
gh release create "$tag" "$asset" "$ios_asset" --title "$title" --notes-file <(tail -n +2 "$NOTES")

# Installed apps pick it up from here; a failure leaves the GitHub release as is
# and can be re-run: bash scripts/publish-update.sh <version> --app <Eos.app> --notes <notes>.
bash "$ROOT/scripts/publish-update.sh" "$version" --app "$built" --notes "$NOTES"
echo "released $tag"
