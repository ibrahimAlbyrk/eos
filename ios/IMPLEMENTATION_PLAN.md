# Eos iOS Client — Implementation Plan

Status: planning only (no code yet). Built strictly against
`docs/ios-remote-protocol.md` (wire+crypto, byte-exact) and `docs/ios-remote-control-design.md`
(§3, §5). Ports the live/render logic from `app/ui/src/`. Confined to `ios/`.

## 0. Build reality (verified)

- Toolchain present: Xcode 26.5, iOS 26.5 SDK + Simulator runtime, Swift 6.3.2.
- Device runs iOS 27 (> SDK 26.5) → cannot deploy to device from this Xcode.
  Verification path = **iOS 26.5 Simulator** (a 27.0 sim runtime is also installed).
  The Simulator reaches relay+daemon over the network for real E2E testing.
- Signing teams available: MW57K22389 / 967U96HU9W (per-build bundle-id; design §9).
- Secure Enclave caveat: the Simulator has **no SE**. SE-backed `I_dev` signing
  (pairing/connect/step-up) verifies only on a physical device. Plan: a
  `DeviceIdentity` protocol with an SE impl + a **software-P256 fallback** (DEBUG /
  `#if targetEnvironment(simulator)`) so the full handshake + AEAD + resume + control
  loop is E2E-testable on the Simulator; SE path is exercised on-device once iOS 27
  build access exists. Fallback never compiles into a release build.

## 1. Xcode project structure (`ios/`)

SwiftUI app, iOS 26 target. SPM deps: `swift-sodium` (pinned commit) → `Clibsodium`;
CryptoKit is first-party. Layout mirrors the contracts→transport→data→ui direction:

```
ios/
  EosRemote.xcodeproj
  EosRemote/
    App/                 EosRemoteApp.swift, RootView, deep-link router (eos://worker, eos://pending)
    Crypto/              CryptoSuite (sodium kx/generichash/xchacha explicit-nonce C calls),
                         DeviceIdentity (SE P256 + sw fallback), MacIdentity verify, KDF, nonces, AAD
    Transport/           Envelope codec (binary, big-endian), WSConnection actor, AEAD codec,
                         Handshake (pair/connect/resume state machines), control req/reply, backoff
    Pairing/             QRScanner, PairingFlow, Keychain store (ticket + bearer + devId)
    Data/                Store actor (workers/pending dicts), patch/snapshot apply, EventsWindow
                         (port eventsStore), ThinkingBuffers (thinkingStore), TerminalBuffers
                         (terminalStore), MessageNormalizer (messageParser), Outbox dedup
    Models/              Codable inner-frame types, Worker/Pending/Event, block model
    Views/               FleetView, WorkerDetailView, PendingListView, AskUserSheet, SpawnSheet,
                         transcript block views (~16 kinds), permission/ask cards, composer
    StepUp/              biometric step-up coordinator (challenge → SE sign → stepUp field)
  IMPLEMENTATION_PLAN.md
```

Codable structs for every inner frame; a manual binary coder for the outer envelope
(§4.1) — no JSON for the envelope header.

## 2. Crypto (per spec §1, LOCKED — no invention)

- **Identity:** P-256 ECDSA/SHA-256. `I_dev` = `SecureEnclave.P256.Signing.PrivateKey`
  (`.privateKeyUsage + .biometryCurrentSet`), `dataRepresentation` in Keychain
  (`WhenUnlockedThisDeviceOnly`). Mac verify via `P256.Signing.PublicKey`.
  Wire: pubkey = `x963Representation` (65B SEC1 `0x04‖X‖Y`); sig = `rawRepresentation`
  (64B r‖s, NOT DER).
- **Ephemeral DH / session keys:** libsodium `crypto_kx`, **role-fixed** — device =
  CLIENT (`crypto_kx_client_session_keys`). `K_c2s = tx_c`, `K_s2c = rx_c`.
- **KDF:** keyed BLAKE2b — `crypto_generichash(out32, label‖TH, key)`. `TH` = unkeyed
  BLAKE2b-256 over the exact handshake concatenation in §2.
- **AEAD:** XChaCha20-Poly1305-IETF via the **explicit-nonce C call**
  `crypto_aead_xchacha20poly1305_ietf_encrypt` (NOT swift-sodium's auto-nonce wrapper).
  Nonce = `epoch(1)‖dir(1)‖seq(8 BE)‖0×14`. AAD = `ver‖epoch‖dir‖seq‖roomLen‖room‖clientId`.
  Output = `ciphertext‖tag16`. Per-direction seq counters from 0 under epoch 0.

## 3. WSConnection actor + handshakes

- One `URLSessionWebSocketTask`. LAN: `wss://<mac>:7400/ws`, self-signed cert **SPKI-pinned**
  via `URLSessionDelegate` against QR `lanSpki`. Relay: public-CA TLS (no pin), per-device
  bearer in `Authorization: Bearer` upgrade header + `join` payload.
- Actor responsibilities: outer-envelope (de)framing, AEAD seal/open, per-direction seq,
  `correlationId → continuation` map with timeout for control req/reply, keepalive ping
  (`sse.keepaliveMs`), backoff **1s→60s** (port `sse.js`).
- Handshakes (spec §2): **PAIR** (QR ots → enroll, Face ID), **CONNECT** (allowlisted
  re-auth, Face ID), **RESUME** (PSK-(EC)DHE binders, **no Face ID**). Transcript-bound
  SIGMA-I signatures; pin-assert `iMac == QR macPub` (fail = abort/MITM). Errors mapped to
  the §7.2 enum (TICKET_REUSE → wipe ticket family + force cold + alert).

## 4. Pairing / QR

- `AVFoundation` QR scan → decode QR JSON (§6): `macPub`, `ots`, `lan[]`, `lanSpki`,
  `relay{url,room}`, `bearer`, expiries. Generate SE keypair, run PAIR handshake, store
  durable `{bearer, devId}` + first ticket `{ticketId, PSK, idleExp, absExp}` in Keychain.
  Single-use `ots`; expiry-checked; fail-closed on a burned/expired QR.

## 5. Data layer (port `app/ui/src/`, re-pointed at the WS — push not refetch)

- **Store actor**: `workers`/`pending` as id-keyed dicts. Apply `snapshot` (cold/gap),
  `patch{op:upsert|remove}` (replaces the web refetch-on-nudge — zero WAN chatter),
  `event{reason}` (18 bus topics verbatim). Detect seq gaps → request snapshot (SEQ_GAP).
- **EventsWindow** (port `eventsStore.js`): newest-first `order:desc limit 500` via tunneled
  `control GET /workers/:id/events`, older via `beforeId`, live via `afterId`; union-merge by
  id sorted `(ts,id)`; cap attached/detached windows; read-ahead prefetch.
- **ThinkingBuffers** (port `thinkingStore.js`): `(workerId, blockId)` buffer, start/append/stop
  from `agent:delta`; channels `text`/`reasoning`; drop on durable same-blockId → flicker-free.
- **TerminalBuffers** (port `terminalStore.js`): `terminal:chunk`/`terminal:done` + afterId backfill.
- **MessageNormalizer** (port `messageParser.js` `normalizeEvents`): both taxonomies → one block
  model. Legacy `WorkerEventType` pass-through; canonical `agent_event` expands to
  jsonl/tool_running/tool_done/hook/exit, **preserving blockId**. ~15 normalized block kinds →
  ~16 render kinds.
- Resilience: a drop loses only in-flight token animation; durable timeline reconverges.
  `clientMsgId` dedups message retries; control = correlationId map + timeout.

## 6. Screens (design §5.3) — navigation stack, not 3-pane

- **Fleet (root):** orchestrators/workers split by `is_orchestrator`; state chip, model·effort,
  live token/cost, tasks progress, activity glyph; pinned pending banner; swipe lead=message,
  trail=Kill(confirm); long-press menu; "+" spawn.
- **Worker detail:** live transcript + streaming thinking; inline Approve/Deny + ask_user card;
  composer → `POST message {text, clientMsgId, queueWhenBusy}`; interrupt/resume; queue pills.
  Transcript blocks: the ~16 kinds (user/assistant/thinking/tool/toolGroup/agentRun/report/
  directive/peer-request/loop/terminal/deliveryFailed/cleared/push/pull/worktreePreserved).
- **Pending list:** tool+input summary+TTL → `POST /pending/:id/decision` (Approve = **step-up**).
- **ask_user sheet:** first-class; multi-select + free-text → `POST /workers/:id/question-answer`.
- **Spawn sheet:** progressive disclosure over `POST /workers`; spawn = **step-up**.
- Native: swipe-to-kill, pull-to-refresh, context menus, haptics, Live Activity (Faz 2),
  quick-approve push action (opt-in, Faz 2+).
- **Transcript escape hatch:** if native markdown/diff/tool-card rendering proves too costly,
  a per-timeline `WKWebView` may embed the existing React renderer fed by the native store
  (design §3.3) — decided per-timeline, not whole-app.

## 7. Step-up (spec §7.3) — high-risk verbs

`StepUpCoordinator`: for any HIGH-RISK control (§8.3 — spawn, kill, terminal, decision, git
push/action, permission/backend switch, open/reveal, rewind, try, fs mutations, etc.):
`control POST /stepup/challenge` → `challenge{nonce}` → build `stepUpMsg`
(`"eos/v1 stepup"‖method‖path‖hex(bodyHash)‖b64u(nonce)‖ts`) → SE sign (Face ID) →
attach `stepUp{challengeNonce, ts, sig}` to the control frame. `bodyHash` over the exact
serialized body bytes (no re-serialization). Read/low-risk carry no stepUp. Capability tiers
from §8.1–8.4; REFUSED routes never sent.

## 8. Background (design §5.4)

On background: drop socket, persist `lastContentId` + resumption ticket. On foreground:
reconnect → RESUME (no Face ID) → lean snapshot + `afterId` backfill. Push is opt-in/dormant
by default (no APNs dependency); foreground reconnect reconverges state.

## 9. Interop gate (spec §9)

Before trusting the transport, reproduce the committed golden fixture in
`docs/vectors/ios-remote-v1/` byte-for-byte — primary go/no-go = the `ka` data-frame vector
(`{"t":"ka","ts":0}`, K_c2s_final, epoch0/dir0/seq0 → ciphertext‖tag). Also pass the X25519,
XChaCha, BLAKE2b, and P-256-verify KATs. The first implementer commits the goldens; iOS
matches. Coordinate the fixture with the relay/daemon owners and the spec author.

## 10. Build order (relay-first, design §8 roadmap)

1. Project skeleton + SPM + crypto suite → pass KATs + golden `ka` frame (Simulator, sw-P256 fallback).
2. Envelope codec + WSConnection + RESUME/CONNECT/PAIR against the daemon over relay.
3. Data layer (store + events + thinking + terminal + normalizer).
4. Fleet + Worker detail (read + message + interrupt + approve/deny + ask_user) = Faz-1 MVP.
5. Step-up + spawn/kill + LAN-direct + remaining control parity (Faz 2).

## Open coordination items (need peers/spec author)

- Golden fixture ownership + commit location `docs/vectors/ios-remote-v1/` (who computes first).
- `/stepup/challenge` virtual-route placement in WsBridge (spec §12.5) — daemon owner.
- libsodium version pinned on both ends so `crypto_kx`/BLAKE2b bytes agree (spec §12.4).
- swift-sodium pinned commit selection.
```
