# Eos iOS Remote Control — Architecture & Design

Status: **Settled** (reconciled result of a 4-expert convergence). This document is the
authoritative design a developer builds from. It is not a changelog and not a debate log —
the decisions below are the design.

---

## 1. Overview & Goal

The goal is a native iPhone app that controls Mac-side Eos **live and low-latency, exactly
like sitting at the Mac**: watch the fleet, follow worker transcripts with streaming
thinking, approve/deny permissions, answer the orchestrator's `ask_user` questions, message
/ interrupt / kill workers, and spawn new work.

Two connection modes share **one codebase and one transport**:

- **Mode A — LAN-direct.** Phone and Mac are on the same network. The phone dials the Mac
  directly. No server in the middle.
- **Mode B — Self-hosted relay.** The phone and the Mac each dial *outbound* to a small
  relay server the user runs themselves. Works through NAT/CGNAT — this is the path for
  remote development from anywhere.

Eos is open-source and self-hostable end to end. The connection address is **user-configurable
on both ends** (phone and Mac); there is no hosted Eos service, no shared bundle-id, and no
mandatory third-party dependency.

### Topology — Mode A (LAN-direct)

```
        same Wi-Fi / LAN
  ┌────────────┐                 ┌──────────────────────────────┐
  │  iPhone    │   wss (pinned   │  Mac                         │
  │  SwiftUI   │   self-signed   │  ┌────────────────────────┐  │
  │  app       │───cert)────────▶│  │ /ws gateway (only net  │  │
  │            │   GET /ws       │  │ surface, port 7400)    │  │
  └────────────┘                 │  └───────────┬────────────┘  │
                                 │      loopback│ (REST/SSE/7401)│
                                 │  ┌───────────▼────────────┐  │
                                 │  │ Eos daemon + workers   │  │
                                 │  └────────────────────────┘  │
                                 └──────────────────────────────┘
```

### Topology — Mode B (self-hosted relay)

```
  ┌────────────┐                 ┌─────────────────┐                 ┌──────────────┐
  │  iPhone    │  outbound wss   │  Relay server   │  outbound wss   │  Mac         │
  │  SwiftUI   │────(443)───────▶│  (dumb pipe)    │◀───(443)────────│  RelayConn-  │
  │  app       │   join room     │  routes on a    │   register room │  ector dials │
  │            │                 │  cleartext      │                 │  out         │
  │            │◀═══ E2E ═══════════ ciphertext, opaque to relay ════════▶          │
  └────────────┘                 └─────────────────┘                 └──────────────┘
        Both legs dial OUTBOUND → no inbound NAT holes, no STUN/TURN.
        Relay sees only an outer envelope {room, clientId, dir, epoch, seq, sizes}.
        Inner frames are end-to-end encrypted; the relay never parses them.
```

The relay is a **dumb forwarder**: it sees a cleartext routing envelope and an opaque
ciphertext payload it cannot read. All confidentiality and authentication are end-to-end
between phone and Mac.

---

## 2. Architecture

### 2.1 One authenticated WebSocket for the remote edge

The entire remote contract is a single authenticated WebSocket: `GET /ws`. It multiplexes
**both** directions of traffic:

- **server → client** — the live stream (mirrors today's loopback SSE plus a `seq` cursor).
- **client → server** — control calls (message, interrupt, kill, spawn, decisions, answers).

The existing **loopback SSE + REST stay untouched** — they continue to serve the local web
UI exactly as today. The WS is an additive remote edge, not a rewrite.

A `control` frame from the client is dispatched into the **existing route handlers**
(`manager/routes/*`) through a small virtual-response shim. This is the DRY core of the
design: there is one control surface, and remote control reuses the same handlers the local
REST API already exercises — no parallel command API to maintain.

#### Frame types

server → client:

- `event{seq, reason, ts, payload}` — mirrors today's SSE `change` frame plus a `seq`
  cursor; carries the 4 live channels. `reason` is the EventBus topic verbatim.
- `patch{seq, resource, op:upsert|remove, data}` — incremental resource update; replaces
  refetch-on-nudge so there is no WAN refetch chatter.
- `snapshot{seq, workers, pending}` — full state for a cold start or after a sequence gap.
- `reply{correlationId, status, body}` — the response to a `control` call.
- `ka` — keepalive.

client → server:

- `hello{lastContentId, resumptionTicket, resumeEphemeralPub}` — opening frame for
  (re)connection and resume.
- `control{correlationId, method, path, body}` — a tunneled REST call; dispatched into the
  existing route handlers via the shim.

### 2.2 The gateway is the only network surface

The remote network surface is **only** the `/ws` gateway. Everything else stays loopback:

- the rich REST API stays loopback-only;
- the raw byte server on **port 7401** stays loopback-only.

The gateway terminates auth + E2E, then invokes the existing REST handlers over loopback and
streams the EventBus out as encrypted frames.

A **loopback-lock middleware** is added at the `makeHandler` chokepoint
(`daemon.ts:308`, after CORS and before the router). It **rejects any non-loopback request
that is not the authenticated WS upgrade**. This neutralizes the worst failure mode — someone
flipping `daemon.host` to `0.0.0.0` and exposing the whole REST surface — because even with a
public bind, the only thing reachable from off-box is the authenticated, E2E-terminating WS.

### 2.3 Dumb relay + end-to-end encryption (day one)

In Mode B the relay is a **dumb pipe**. It routes purely on a cleartext **outer envelope**:
`{room, clientId, dir, epoch, seq, sizes}`. The inner content is opaque ciphertext it never
parses. Consequences:

- The relay is **Eos-protocol-version-independent** — it forwards bytes; it does not know the
  control protocol and never needs to be upgraded when the protocol evolves.
- **Metadata exposure is Signal-level**: no identity, no content — only room membership,
  direction, sequence, and frame sizes.
- Because E2E is **pairwise per device**, the Mac emits **N per-device ciphertexts**; the
  relay is a pure **unicast forwarder** plus a **hash-allowlist admission** check.

Both legs **dial outbound** to the relay, so the design traverses CGNAT and symmetric NAT
with **no inbound holes and no STUN/TURN**.

---

## 3. Key Decisions & Rationale

### 3.1 WebSocket, not SSE or WebRTC

WS is the **only** transport that serves **both** topologies with one codebase:

- LAN-direct (iPhone dials the Mac) **and** Mac-dials-relay (Mac dials outbound).
- **SSE cannot do the Mac-dials-out leg**, and `EventSource` cannot carry an auth header.
- **WebRTC** drags in coturn / libwebrtc and flaky mobile ICE for marginal latency. The
  perceived lag in this product is **model generation, not transport** — so the latency win
  does not justify the operational weight. WebRTC remains a possible **Phase-3 LAN-only**
  optimization.

### 3.2 Dumb relay + E2E, from day one

A TLS-terminating or content-aware relay would make the relay a high-value target whose
compromise leaks everything. Making it a dumb pipe with end-to-end encryption from the first
shipped version means relay compromise is bounded to **metadata + denial-of-service**, and the
relay can be small, stateless, and protocol-agnostic.

### 3.3 Native SwiftUI, not a WebView

The remote contract is one AEAD-encrypted WS where REST is tunneled and **every frame is
sealed with a session key derived from a Secure-Enclave key reachable only from native code**.
A `WKWebView` cannot perform the SIGMA handshake, cannot sign with the Secure-Enclave key, and
cannot per-frame-encrypt. A WebView approach would therefore require rewriting the entire React
transport into a native crypto bridge anyway — while keeping desktop-shaped views. Native also
wins swipe-to-kill, lock-screen quick-approve, Live Activity / Dynamic Island,
Keychain/biometric integration, and deep-link routing.

**Hybrid is kept only as a narrow escape hatch** for the transcript pane — the single costliest
port (`app/ui/src/messageParser.js` `normalizeEvents` ~490 lines + `Messages.jsx`'s 16 block
kinds). That one pane *may* embed the existing React renderer in a `WKWebView` fed by the
native store, **decided per-timeline, not whole-app**.

### 3.4 The biometric / resumption model (the UX ↔ safety resolution)

The tension is: Face ID on every reconnect is unusable; never requiring it is unsafe. The
resolution layers three states:

- **Cold handshake = Face ID.** On first pair or after ticket expiry, the Secure Enclave
  produces a signature. This issues a rotating **resumption ticket** that is **read + low-risk
  only**: `{ticketId + PSK}`, stored in the Keychain as `WhenUnlockedThisDeviceOnly`, with **no
  biometric ACL**.
- **Reconnect within TTL = no Face ID.** A PSK-(EC)DHE re-auth (the TLS-1.3 resumption
  pattern) with a fresh ephemeral key. Smooth foreground reconnects.
- **High-risk / RCE verbs always require a fresh per-action Secure-Enclave signature.** This
  set is: terminal exec, spawn / `bypassPermissions`, kill, approving a permission decision,
  git push, and host-app open/reveal. A stolen ticket is therefore **bounded to read-only and
  never reaches RCE**. Read, message-worker, and answer-question need **no step-up**.

The resumption ticket is bounded three ways: **capability** (read-only), **time** (idle ~24h
sliding + absolute ~7d), and **single-use rotation** (reuse → invalidate the ticket family +
force a cold handshake + raise an audit alert). The **Mac holds authoritative ticket state**
and a **panic-invalidate-all**.

---

## 4. Security Model

### 4.1 Ranked threat model

1. **Open LAN bind (`host=0.0.0.0`) = zero-cred RCE — HIGHEST.** Neutralized by
   gateway-only network surface + the loopback-lock middleware.
2. **Stolen / unlocked paired device.** Bounded by the Secure-Enclave key + biometric ACL +
   per-device revocation + read-only resumption tickets + per-action step-up on RCE verbs.
3. **Relay compromise — HIGH impact, CUT to metadata + DoS** by end-to-end encryption.
4. **MITM on the relay path.** Closed by Noise mutual auth + certificate pinning.
5. **Replayed credential.** Closed by the per-frame nonce + single-use pairing secret +
   revocable bearer.
6. **On-box malicious agent.** Contained by preserving the local `ui-token` gate (below).

### 4.2 Auth on every channel — two layers on the one WS

1. **Transport admission** — a per-device **256-bit opaque, revocable bearer** carried in the
   WS upgrade header. Enforced by the **relay** in Mode B and by the **daemon** in Mode A. This
   is the weaker, rotatable layer; it gates who may open a socket.
2. **The auth that matters** — the **Noise XX handshake with long-term static device keys**
   (the Mac's identity key + each phone's per-device identity key). **Mutual**: the Mac key is
   QR-pinned by the phone; the phone key is Mac-allowlisted.

### 4.3 Pairing / provisioning

- The Mac app shows a **QR** containing: the Mac static public key, a **one-time, short-lived,
  single-use pairing secret**, the LAN/relay addresses, the cert fingerprint, and an expiry.
- The phone **generates its own device keypair in the Secure Enclave** (non-exportable,
  biometric ACL).
- A **SIGMA handshake** authenticated by the one-time secret + the pinned Mac key proves both
  *this is the real Mac* **and** *a human scanned the code*.
- The phone sends its **device public key + a label**; the Mac stores it in a per-device
  keyring and issues the **per-device relay bearer**.
- **Revocation = two independent kill switches**: remove the device from the keyring (kills
  the E2E key) **and** drop the bearer hash at the relay (kills admission).

#### Key storage

- **Mac:** device **public** keys in `~/.eos/devices` (file mode 0600); the Mac **static
  private** key in the macOS Keychain (file-0600 acceptable for MVP).
- **iOS:** the device **private** key in the Secure Enclave
  (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` + biometric ACL).

### 4.4 Encryption & relay trust

- **Handshake:** Noise XX with per-session ephemeral X25519 → **forward secrecy**.
- **Per-frame:** XChaCha20-Poly1305 AEAD; **nonce = dir‖seq**; a 1-byte key-epoch is reserved
  for a Phase-2 rekey.
- **Pairwise per-device keys** → clean revocation and per-device unicast from the relay.
- **Relay trust = none beyond routing.** It sees only `{room, clientId, dir, epoch, seq,
  sizes}` and forwards opaque ciphertext. Compromise is bounded to metadata + DoS.

### 4.5 The `ui-token` composition (compose, do not replace)

The existing `ui-token` remains the **local human-UI-vs-on-box-agent separator**. It **never
travels remotely**. Both of its comparisons are made constant-time
(`crypto.timingSafeEqual`) at `fs-shared.ts:25` and `workers.ts:718`. When an authorized
remote device hits a `ui-token`-gated route, the gateway **supplies the token locally** — but
only if that device holds the **"mutate working tree"** capability. The on-box agent still has
neither a paired device nor the token.

### 4.6 Hardening

- Remote is **OFF by default**, with explicit local enable, a visible **"remote armed"**
  indicator, and an **auto-expiring inactivity lease**.
- An **append-only audit log** of every remote-originated control action
  `{device, action, target, ts, result}`, surfaced in the Mac app.
- **Rate-limit per-device and global** on the gateway, with **heavy throttle / lockout** on
  the pairing endpoint.

### 4.7 Audit findings — must-keep-local

- The raw **7401** server (no CORS, no token, serves arbitrary disk bytes via
  `GET /fs/raw/<abspath>`) **MUST stay loopback-only**.
- The worker-ingest plane — `POST /workers/:id/events`, the worker-side `/policy/decide`,
  `/peer-request`, `/peer-response`, `/question-answer` — **loopback-only, never remote**.
- The `ui-token` compares were plain `===` (timing-leaky) → **made constant-time**.

### 4.8 Explicitly UNSAFE to ship

- `host=0.0.0.0` as the remote mechanism.
- Any TLS-terminating / plaintext relay.
- The `ui-token` or any bearer as the **sole** remote auth.
- Exposing the raw 7401 server or the worker-ingest routes remotely.
- SSE + a query-param token as remote auth.
- A plain `===` token compare on any remote-reachable surface.

---

## 5. iOS App

### 5.1 Native SwiftUI

A native SwiftUI app (see §3.3 for why not a WebView). The transcript pane may optionally
embed the existing React renderer in a `WKWebView` fed by the native store — decided
per-timeline.

### 5.2 Data / live layer

Port `app/ui/src/hooks/useLive.js` + `state/*Store.js`, re-pointed at the WS.

- **Store = a Swift actor**; `workers` and `pending` are **dictionaries keyed by id**.
- The server **pushes `patch{op:upsert|remove}`** instead of refetch-on-nudge → **zero WAN
  refetch chatter**; a `snapshot` arrives on cold start or after a gap.
- `event` frames carry `reason` = the bus topic verbatim (**18 topics**).

#### Streaming thinking

- `agent:delta` (live thinking) ports `thinkingStore.js`: buffer keyed `(workerId, blockId)`,
  with start/append/stop; a buffer is dropped **only** when the durable canonical block with
  the same `blockId` arrives → **flicker-free**. Channels: `text` = live assistant text,
  `reasoning` = thinking.
- `terminal:chunk` / `terminal:done` port `terminalStore.js` + an `afterId` backfill on
  `done`.

#### Transcript paging

Port `eventsStore.js`: newest first (`order:desc limit 500`), older via `beforeId`, live delta
via `afterId`, an **id-keyed union merge sorted by `(ts, id)`**.

#### The two event taxonomies — normalized once at ingest

Both taxonomies are normalized **once at ingest** (port `normalizeEvents`): legacy
`WorkerEventType` rows pass through; `type:agent_event` canonical rows expand to
`jsonl` / `tool_running` / `tool_done` / `hook` / `exit`, **preserving `blockId`** → one
renderer.

#### Resilience

- A long drop loses only the **in-flight token animation** (cosmetic) — final blocks
  reconverge from the durable timeline.
- Control calls = a `correlationId → continuation` map with a timeout.
- `clientMsgId` dedups message retries.

### 5.3 Screens & interactions

A **navigation stack** (not a 3-pane desktop layout):

- **Fleet (root).** Orchestrators / workers split by `is_orchestrator`. Rows show a state
  chip, model·effort, live token/cost, tasks progress, and an activity glyph. A pinned
  **pending banner**. Swipe leading = message, trailing = **Kill (confirm)**. Long-press =
  interrupt / model / permission / kill. **"+"** = spawn sheet.
- **Worker detail.** Live transcript with streaming thinking; an inline permission
  **Approve/Deny** card + an `ask_user` answer card; a composer →
  `POST message {text, clientMsgId, queueWhenBusy}`, interrupt / resume; queued-message pills.
- **Pending list.** Tool + input summary + TTL → `POST /pending/:id/decision`. Approve = **SE
  step-up**.
- **`ask_user` sheet.** Question + options → `POST /workers/:id/question-answer
  {toolUseId, answers}`; multi-select + free-text. **First-class** — the orchestrator's only
  human channel.
- **Spawn sheet.** The large `POST /workers`, phone-shaped via progressive disclosure.
  Primary: prompt (+ templates), dir / `worktreeFrom` (+ recents / branches), model + effort.
  Advanced: `from` / `toolsAllow` / `toolsDeny` / `collaborate` / `loop`. Spawn = **SE
  step-up**.

**Native touches:** swipe-to-kill, pull-to-refresh, context menus, haptics, Live Activity /
Dynamic Island for a running worker, quick-approve from a push action.

### 5.4 Transport & background

- **One** `URLSessionWebSocketTask`, the **same code** for LAN (`wss://<mac>:7400/ws`,
  self-signed cert **pinned** via `URLSessionDelegate` SPKI vs the QR fingerprint) and relay
  (the relay bearer in the upgrade header).
- A **`WSConnection` actor**: AEAD codec, control req/reply, a keepalive ping
  (`sse.keepaliveMs`), backoff **1s → 60s** (like `sse.js`).
- **Background:** on background, drop the socket and persist `lastContentId` + the resumption
  ticket; on foreground, reconnect → resume (**no Face ID**) + a lean snapshot + an `afterId`
  backfill.

### 5.5 Push notifications — opt-in, foreground-first

By default the app is **foreground-only** and has **no APNs dependency** — it is fully
self-hostable with zero push infrastructure. On foreground, the app reconnects via the
resumption ticket and the fleet / pending state reconverges instantly. This is the default
behavior.

**Background push is an opt-in add-on**, inert unless the user configures **their own** APNs
key + bundle-id. The path is built but dormant by default. When enabled it works as:

- A **content-free** push intent: `{t:pushIntent, reason, workerId, title, body, deeplink}`,
  emitted for `permission_request`, a worker reaching done/failed, and `ask_user`.
- The **relay owns APNs egress**; iOS registers its device token via the **join frame**.
- The notification carries **no real content** — the title/body come from a **closed
  reason → title table**; the real content is fetched **E2E after biometric unlock**.
- Deep links: `eos://worker/<id>`, `eos://pending/<id>`; **Approve/Deny** notification actions.

To enable background push, the user supplies their own APNs auth key and bundle-id (a paid
Apple Developer account is required for APNs — see §9). With no APNs configured, none of this
runs and nothing depends on it.

---

## 6. Eos (Mac) Changes

Concrete change list with real anchors:

1. **`config.remote`** in `manager/shared/config.ts` —
   `{mode: off|lan|relay, relayUrl, room, auth...}`, **off by default**.
2. **`/ws` endpoint + a `WsBridge` module** on the main server (`daemon.ts:337`):
   EventBus ↔ WS, `seq`, the control-dispatch shim, and push-delta / lean-snapshot /
   coalesce logic.
3. **`RelayConnector`** — outbound `wss` dial + register + reconnect, reusing `WsBridge`.
4. **The transport auth hook** at the WS handshake and at relay register / join.
5. **The loopback-lock middleware** at `makeHandler` (`daemon.ts:308`); keep the raw 7401
   server and the REST API loopback-only.
6. **A new Preferences window** in `app/main.swift` (there is none today — a ~971-line single
   file that hardcodes `127.0.0.1:7400` at ~8 sites). **Keep the webview on loopback** — the
   IP field configures the daemon's **remote exposure**, not the webview. (Easy to get
   backwards; the webview must never leave loopback.)
7. **Constant-time `ui-token` compare** (`fs-shared.ts:25`, `workers.ts:718`); the **audit
   log**; **rate-limiting**.

**Leave alone:** `EOS_DAEMON_URL` / `sdkDaemonUrl` loopback hardcode
(`container.ts:446` / `:659`) — workers and the SDK lane always talk to the **local** daemon.

**Why Eos is close already:** SSE is already a stateless fan-out, `events.id` is a monotonic
cursor, and control is one HTTP API. So most of the work is "add a new transport + auth shell,"
not rewriting existing logic.

---

## 7. Relay Server

### 7.1 What it is

A small, standalone, **dumb unicast forwarder** (~200–400 LOC in Node / Bun / Go). A single
public `wss` on port **443**, an in-memory room registry, hash-allowlist admission, and TLS via
Let's Encrypt / ACME. Ships as a single binary or a tiny Docker image. It is the **first
standalone buildable artifact** and can be prototyped before any daemon changes land.

### 7.2 Envelope & routing

The relay routes purely on a cleartext **outer envelope**:
`{room, clientId, dir, epoch, seq, sizes}`. The inner payload is opaque ciphertext it never
parses. Because E2E is pairwise, the Mac sends N per-device ciphertexts and the relay forwards
each to its single recipient (**pure unicast**). Admission is a **hash-allowlist** check of the
per-device bearer; the relay never sees a private key or any plaintext content.

### 7.3 Deployment & config (both ends)

- Run the relay on any small VPS with a public DNS name; ACME provisions TLS automatically.
- **Mac:** `config.remote = {mode: relay, relayUrl, room, auth...}` — the `RelayConnector`
  dials out and registers the room.
- **Phone:** the relay URL + room arrive via the pairing QR; the app dials out and joins the
  room with its per-device bearer.

### 7.4 Opt-in APNs egress

When the user enables background push (§5.5), the **relay owns APNs egress**: it receives the
content-free `pushIntent`, looks up the registered device token (from the join frame), and
sends the APNs payload using the user's **own** APNs key + bundle-id. With push disabled, the
relay does no APNs work and requires no Apple credentials.

---

## 8. Roadmap — relay-first

Priority is **remote development from anywhere**, so the relay path is the first usable
milestone after the shared spine.

### Faz 0 — Spine (shared, prerequisite for everything)

- Pairing (QR + Secure Enclave + SIGMA + Keychain).
- The `/ws` gateway (the only network surface) + the loopback-lock middleware.
- E2E (Noise XX → XChaCha20-Poly1305 AEAD).
- Device allowlist + per-device revocation; the audit log.
- iOS `WSConnection` actor (AEAD codec, control req/reply, snapshot/patch, resume).
- **Security non-negotiables live here:** per-action Secure-Enclave step-up on high-risk
  verbs, remote-off-by-default, constant-time `ui-token`.

### Faz 1 — Relay (THE PRIORITY: remote dev from anywhere)

- `RelayConnector` outbound dial + register.
- The dumb unicast relay server (~200–400 LOC; single public `wss`/443; in-memory room
  registry; hash-allowlist admission; TLS via Let's Encrypt/ACME; single binary or tiny
  Docker).
- `relayUrl` / `room` config on both ends; multi-client.
- The **MVP control surface over the relay**: fleet list live, worker transcript with
  streaming thinking, approve/deny permissions, `ask_user` sheets, message / interrupt / kill.
- The patch-push chattiness fix.
- Foreground resumption (no Face ID) + per-action SE step-up.
- *(The relay server is the first standalone buildable artifact and can be prototyped before
  the daemon changes.)*

### Faz 2 — LAN-direct + full control parity

- LAN-direct mode (bind via the gateway; mDNS/Bonjour or manual IP entry; self-signed cert
  pinned via QR) as a same-network convenience.
- Spawn sheet; orchestrator spawn/message; model / effort / permission / backend switch; queue
  pills; rewind; Live Activity; the replay ring-buffer (re-encrypt model); notification
  quick-actions; an optional SAS confirm.

### Faz 3 — Power + hardening

- Git/diff review; Files explorer; terminal; templates/memory; policy rules; iPad split.
- E2E group-key fan-out; size/timing padding; encrypted APNs via NSE; an auto-expiring lease;
  anomaly detection.
- The optional WebRTC LAN P2P.

**Caveat:** relay-first means the full crypto/client stack is first exercised against the
relay topology (a server in the middle) rather than the simpler LAN path. This is acceptable
given remote dev is the immediate need, and is mitigated by the relay being small.

---

## 9. Build & Install (self-host)

Distribution is **self-build only** — not published. There is no App Store and no TestFlight.
Each user builds in Xcode with **their own bundle-id and signing** and installs directly to
their device. Because Eos is open-source, anyone clones the repo and builds the same way.

This fits the pairing model directly: identity is **per-build / per-device** (each install has
its own bundle-id and its own Secure-Enclave device key), so there is no shared bundle-id to
coordinate and no App-Store-review constraint to design around.

**Signing cadence:**

- **Free Apple ID** → the app must be re-signed every **7 days**.
- **Paid Apple Developer account** → signing is valid for **1 year**, and it **also unlocks the
  opt-in APNs background push** (§5.5). Recommended.

**Steps:**

1. Clone the repo.
2. In Xcode, set **your** bundle-id and signing **team**.
3. Build to your device.
4. *(Optional)* Configure your **APNs key + bundle-id** to enable background push.
5. Pair: scan the QR shown in the Mac app; the phone generates its Secure-Enclave key and is
   added to the Mac keyring.

---

## 10. Open Items

- **APNs requires a paid Apple Developer account.** Background push (§5.5) is therefore gated
  on the user holding a paid account and configuring their own APNs key. This is by design
  (opt-in, off by default), but it is the one capability a free-Apple-ID self-builder cannot
  enable. Foreground-only operation has no such dependency.
- No section is marked TBD: every cited Eos path, port, and shape in this document comes from
  the verified design backbone. Any **new** anchor added during implementation should be
  re-verified against the source (or with the eos-internals expert) before it is relied upon.
```