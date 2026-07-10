# Eos Remote (iOS) — Build & Install

The native SwiftUI iPhone client for Eos remote control. You build and install it
yourself with your own Apple signing — there is no App Store / TestFlight (design §9).

## What works today

- **Simulator: fully working and verified.** Builds for the iOS-26.5 Simulator; **13 unit
  tests pass** (golden-fixture crypto byte-match incl. the `dataFrameKa` go/no-go gate, the
  full-PAIR choreography reproducing the golden session keys, transport framing).
- **Live end-to-end PROVEN over the relay.** The Simulator client paired with and controlled a
  real Node daemon through the live relay: SIGMA handshake → sealed welcome (durable bearer +
  resumption ticket) → `GET /workers` (200) → per-action Secure-Enclave **step-up** verified.
- **Screens:** Code list (agents tree + Archived), Conversation (live transcript + composer +
  permission banners), New session, Devices (+ device switcher); QR-scan pairing; deep links
  (`eos://worker/…`, `eos://pending/…`).

## Prerequisites

- **Xcode 26.5+** (Swift 6). Check: `xcodebuild -version`.
- **XcodeGen**: `brew install xcodegen` — the `.xcodeproj` is generated from `project.yml`
  (it is intentionally git-ignored, so generate it before first build).
- Network access on the first build so Swift Package Manager can fetch **swift-sodium**
  (pinned to commit `cfd195c…` → libsodium C **1.0.20**, which must match the daemon's
  `sodium-native`). No manual install — SPM resolves it.

## 1. Generate the Xcode project

```bash
cd ios
xcodegen generate          # writes EosRemote.xcodeproj from project.yml
open EosRemote.xcodeproj    # optional — to build from the IDE
```

## 2. Signing

`project.yml` sets **automatic** signing with team `MW57K22389`
(*Apple Development: Ibrahim Albayrak*), so a plug-in-and-Run works out of the box for that
account. To use **your own** Apple ID instead (per design §9 — identity is per-build/per-device):

- In Xcode: select the `EosRemote` target → **Signing & Capabilities** → set your **Team**
  (and a unique **Bundle Identifier** if `dev.eos.remote.app` is taken on your account).
- Or edit `project.yml`: change `DEVELOPMENT_TEAM` and the `PRODUCT_BUNDLE_IDENTIFIER`s, then
  re-run `xcodegen generate`.

A **free** Apple ID works but re-sign every 7 days; a **paid** account signs for 1 year and is
required for the optional background-push add-on (§5.5/§9).

## 3. Build & run on the Simulator (verified)

```bash
# Run the app
xcodebuild build -project EosRemote.xcodeproj -scheme EosRemote \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5'

# Run the test suite (crypto byte-match + choreography + framing)
xcodebuild test -project EosRemote.xcodeproj -scheme EosRemote \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5'
# → 13 passed, 1 skipped (the live-relay E2E, see below)
```

Or just pick an iOS-26.5 simulator in Xcode and press **Run**.

### Simulator pairing without a camera

The Simulator can't scan the pairing QR. Simulator builds accept the v3 QR payload via launch
environment instead: arm an offer (`POST /api/remote/pair` with the `x-eos-ui-token` header from
`~/.eos/ui-token`), then

```bash
SIMCTL_CHILD_EOS_PAIR_JSON="$(curl -s -X POST -H "x-eos-ui-token: $(cat ~/.eos/ui-token)" \
  http://127.0.0.1:7400/api/remote/pair)" xcrun simctl launch booted dev.eos.remote.app
```

### Drawer gesture UI tests (EosRemoteUITests)

On-simulator XCUITests for the drawer drag physics live in the `EosRemote` scheme's test action.
They need the simulator app already paired against a live daemon (above), so they are not part of
the `EosRemoteKit` unit suite:

```bash
xcodebuild test -project EosRemote.xcodeproj -scheme EosRemote \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' -only-testing:EosRemoteUITests
```

### Live relay E2E test (optional, requires a running daemon harness)

`EosRemoteKitTests/LiveE2ETests` is **skipped by default**. It pairs + controls through a live
relay against a daemon-side pairing offer. To run it: have the daemon harness write the §6
pairing payload to `/tmp/eos-pair.json`, then `touch /tmp/eos-live-e2e-go` and run that one test.
(It uses the Simulator's DEBUG software-P256 identity — see the Secure-Enclave note below.)

## 4. Build & install to a physical iPhone

> **REQUIRED FIRST — update Xcode for the iOS 27 SDK.** This iPhone runs **iOS 27**, but the
> currently installed Xcode ships the **iOS 26.5 SDK**. Xcode cannot install to a device whose
> iOS is newer than its SDK. **Update Xcode to a version that includes the iOS 27 SDK before
> deploying to the device** (App Store → Xcode update, or developer.apple.com/download). The
> Simulator path above needs no update. After updating, re-run `xcodegen generate` is not
> required, but a clean build is recommended.

Then:

1. **Connect** the iPhone via USB; on the phone tap **Trust This Computer**.
2. In Xcode, ensure your **Team** is set (step 2). Automatic signing will provision the device.
3. Select the iPhone as the **run destination** (top bar, next to the scheme).
4. Press **Run** (⌘R). On first install, approve the developer profile on the phone:
   **Settings → General → VPN & Device Management → (your profile) → Trust**.
5. Launch the app and **scan the pairing QR** shown by the Eos Mac app to enroll the device.

From the command line, a device archive/build uses automatic provisioning:

```bash
xcodebuild build -project EosRemote.xcodeproj -scheme EosRemote \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates
```

## Secure Enclave vs. the Simulator fallback

The device identity key `I_dev` (used to sign the pairing/step-up challenges) lives in the
**Secure Enclave** — non-exportable, biometric-gated (Face ID / Touch ID). On a **real device the
app always uses the Secure Enclave** (`DeviceIdentityFactory` selects it whenever the target is
not the Simulator, in any build configuration).

The Simulator has **no Secure Enclave**, so a **DEBUG-only software-P256 fallback**
(`SoftwareDeviceIdentity`) stands in there to make the full handshake/AEAD/resume/step-up loop
testable on the Simulator. It is compiled out of **Release** builds (`#if DEBUG`) and is **never
used on a device**. The live-E2E proof above ran with this fallback on the Simulator; the
on-device Secure-Enclave path is exercised once you deploy to the iPhone (after the Xcode update).

## Project layout

```
ios/
  project.yml              XcodeGen spec (targets, signing, swift-sodium pin)
  EosRemoteKit/            Testable core (zero UIKit): Crypto, Transport, Models, Data, Pairing, StepUp
  EosRemote/               SwiftUI app: App, Views, Pairing UI (QR scanner)
  EosRemoteKitTests/       Crypto fixture + choreography + framing + (skipped) live E2E
```
