#!/usr/bin/env bash
# release.sh — build, sign, notarize and publish Eos.app as a GitHub release.
#
#   bash scripts/release.sh <version>        e.g. bash scripts/release.sh 0.1.0
#
# Needs, on this Mac only: the "Developer ID Application" cert in the keychain and
# the notarytool keychain profile `eos-notary` (app/README.md › Signing). Other Macs
# install the published zip through install.sh — they never build or sign.
#
# Steps: bump app/package.json → `npm run make` with EOS_NOTARIZE=1 (sign +
# notarize + staple) → check Gatekeeper accepts it → commit + tag v<version> → push
# → `gh release create` with Eos-darwin-arm64.zip, the fixed name install.sh
# downloads from releases/latest.
set -euo pipefail

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <major.minor.patch>" >&2; exit 1; }
tag="v$version"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
PROFILE="${EOS_NOTARY_PROFILE:-eos-notary}"

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

# A failed build must not leave the version bump behind.
trap 'git -C "$ROOT" checkout -q -- app/package.json app/package-lock.json' EXIT

(cd "$APP" && npm version "$version" --no-git-tag-version >/dev/null)
(cd "$APP" && EOS_NOTARIZE=1 npm run make)

built="$APP/out/Eos-darwin-arm64/Eos.app"
spctl -a -vv "$built" 2>&1 | grep -q "source=Notarized Developer ID" \
  || die "Gatekeeper does not accept $built as notarized"
xcrun stapler validate "$built" >/dev/null || die "the notarization ticket is not stapled to $built"

asset="$APP/out/make/Eos-darwin-arm64.zip"
cp "$APP/out/make/zip/darwin/arm64/Eos-darwin-arm64-$version.zip" "$asset"

git -C "$ROOT" commit -qm "release: $tag" -- app/package.json app/package-lock.json
git -C "$ROOT" tag "$tag"
git -C "$ROOT" push -q origin HEAD "$tag"
gh release create "$tag" "$asset" --title "Eos $version" --generate-notes
echo "released $tag"
