# Eos iOS Remote Control — Connection / Auth / Reconnect v2

Status: **Design — approved approach, awaiting rebuild.** This document specifies a
**replacement** for the connection / authentication / reconnect layer described in
[`ios-remote-protocol.md`](./ios-remote-protocol.md) §2 (PAIR / CONNECT / RESUME). It does
**not** touch the transport (WSS + self-hosted relay behind Caddy/ACME) or the libsodium AEAD
primitives — those are proven and reused verbatim. It replaces only the fragile multi-mode
auth/session/reconnect state machine.

Scope boundary: design only. No code here. A separate rebuild implements it. Nothing is deleted
yet; the explicit delete list is in [§9](#9-explicit-delete-list).

---

## 0. Why v1 failed (the structural diagnosis)

v1 has **three runtime connection modes** layered over a one-time pairing:

| v1 mode | Credential | Where stored | Lifetime |
|---|---|---|---|
| PAIR | one-time secret + one-time bearer | QR → burned | single use |
| CONNECT (cold) | durable per-device bearer (**rotated every connect**) + SE P-256 key (biometric) | Keychain / `~/.eos` / relay allowlist | rotates |
| RESUME (warm) | resumption ticket + PSK (**in-memory on Mac**) | Keychain / Mac RAM | sliding 24h / 7d |

Every recurring bug traces to **one of those moving parts**, not to the crypto:

1. **Durable bearer never added to relay allowlist on reopen → `BEARER_DENIED`.** A separately-synced
   allowlist drifted from the credential it was supposed to admit.
2. **Resume tickets in-memory on the Mac → died on every daemon restart.** Session state that did not
   survive a restart masqueraded as a connectable state on the client.
3. **Biometric Secure-Enclave key made cold-connect signing fail.** A user-presence gate on a key
   that must sign during a background/auto reconnect.
4. **Bearer rotation desynced the relay.** A credential that changes every connect must be
   re-propagated to a second system every connect; one missed propagation = locked out.
5. **Client looped `reconnecting ↔ connecting` forever.** Three modes with three failure
   fall-through paths and no single terminal state.

**Root cause = surface area.** 3 connect modes × (ephemeral tickets + rotating bearers + a
separately-synced allowlist) = too many independently-failing parts that must stay mutually
consistent across two devices, a relay, and restarts. The fix is not better patches — it is
**collapsing to one credential, one handshake, one admission identity, none of which rotate.**

---

## 1. Design goals (acceptance criteria)

1. **One persistent device credential.** A single static key in the Keychain + a single persisted
   allowlist entry on the Mac. Survives app-close and phone-restart. Never rotates.
2. **One connect path, used byte-identically on first connect and every reconnect.** No
   pair/connect/resume split. No ephemeral resume tickets. No bearer rotation.
3. **Relay admission that cannot desync.** A *stable* per-device id derived from the device's static
   key (not a rotating bearer), in a *persisted* allowlist the Mac re-announces on every Mac
   reconnect.
4. **Forward secrecy** via a fresh ephemeral DH mixed with the static keys on every connection.
5. **End-to-end.** The relay stays a blind pipe; it never holds a session key or sees plaintext.
6. **Trivial reconnect.** open / foreground / post-reboot → one handshake → connected. Bounded retry
   → a single clear terminal state. Never an infinite loop. Re-pair only on genuine de-enrollment.

---

## 2. Recommended approach: Noise_IK with persistent static keys

**Recommendation: adopt the Noise Protocol Framework `IK` handshake pattern with long-term static
keys, instantiated as `Noise_IK_25519_XChaChaPoly_BLAKE2b`** — i.e. WireGuard's exact model, reusing
Eos's existing libsodium primitives. This is the single handshake for enrollment and for every
connect thereafter.

### 2.1 The IK pattern

Noise `IK`, from the framework spec ([noiseprotocol.org](https://noiseprotocol.org/noise.html)):

```
IK:
  <- s                       (responder static pre-known by initiator)
  ...
  -> e, es, s, ss            (msg 1: device → Mac)
  <- e, ee, se               (msg 2: Mac → device)
```

- `<- s` (pre-message): the **device already knows the Mac's static public key** — it received it in
  the QR at the one-time pairing. Persisted; never re-fetched.
- Msg 1 `-> e, es, s, ss`: the device sends a fresh **ephemeral** `e`, then transmits **its own
  static** `s` *encrypted to the Mac's static key*. The `es`/`ss` DH operations authenticate to the
  Mac and bind the session.
- Msg 2 `<- e, ee, se`: the Mac replies with its ephemeral; `ee`/`se` complete mutual authentication
  and give the transport keys **forward secrecy** (the per-session ephemerals are mixed in and then
  discarded).

Two messages, one round trip, mutual authentication, forward secrecy. ([WireGuard
protocol](https://www.wireguard.com/protocol/) ships exactly this — `Noise_IKpsk2` — to hundreds of
millions of endpoints.)

### 2.2 Why IK, and why over the KK the brief suggested

KK and IK both authenticate using static keys both sides hold, both are 1-RTT, both give the same
msg-1 sender-authentication grade. The deciding difference is **first connect**:

- **KK** (`-> s` and `<- s` both pre-messages) requires the responder to **already hold the
  initiator's static key before msg 1**. At the very first pairing the Mac does *not* yet know a
  freshly-generated device key. KK therefore needs a **separate enrollment handshake** to teach the
  Mac the device static — i.e. two handshake implementations (enroll-pattern + KK-steady). That
  reintroduces exactly the multi-mode surface we are trying to delete.
- **IK** transmits the initiator's static **inside msg 1** (encrypted). So the *same two-message
  handshake* works on first connect (Mac **records** the static, gated by a one-time enrollment
  token) and on every reconnect (Mac **matches** the static against its allowlist). **One handshake,
  used identically.** The only delta between enroll and reconnect is a single one-time-token field in
  msg 1 and a record-vs-match branch on the Mac — the wire bytes and crypto are identical.

IK is therefore strictly simpler in code (one pattern, not two) **and** is the most battle-tested
precedent available (WireGuard). KK is documented as the viable alternative in
[§A](#appendix-a-kk-alternative) for completeness, but IK is the recommendation.

Security note: both KK-msg1 and IK-msg1 carry the framework's "1" sender-auth grade — authenticated
but vulnerable to **key-compromise impersonation** (KCI): if a party's *own* static private key
leaks, an attacker can impersonate the *other* party to it. This is identical to WireGuard's accepted
posture and requires compromise of a Secure-Enclave-class secret (device Keychain key) or a `0600`
file in `~/.eos` (Mac key). Acceptable, and unchanged from any static-key VPN.

### 2.3 Cipher suite — reuse everything

`Noise_IK_25519_XChaChaPoly_BLAKE2b`:

| Noise role | Primitive | Existing Eos primitive reused |
|---|---|---|
| DH | X25519 | `crypto_scalarmult` (libsodium) — already used for `crypto_kx` ephemerals |
| Hash / HKDF (MixHash, MixKey) | BLAKE2b | `crypto_generichash` — already used for transcript/KDF |
| AEAD (handshake + transport) | XChaCha20-Poly1305 | `crypto_aead_xchacha20poly1305_ietf` — **the fixture-proven byte-exact Swift↔Node primitive** |

`XChaChaPoly` is not a registered Noise cipher name, but it is a valid instantiation: both ends are
ours and use the same libsodium build, so byte-agreement is guaranteed (the property the fixtures
already prove). This keeps the entire crypto surface on the one library Eos has cross-platform
interop for, and **drops P-256/ECDSA and the Secure Enclave entirely** (see §3).

> Implementation note (for the rebuild, not this design): prefer driving the Noise state machine
> (MixHash/MixKey/Split) from a vetted Noise implementation rather than hand-rolling the chaining,
> feeding it the libsodium primitives — "stop writing bespoke crypto state machines" is the whole
> point. The transport frame format (nonce/AAD layout) from `ios-remote-protocol.md` §1.5 is reused
> unchanged after `Split()`.

### 2.4 Precedents (all four pillars of this design are shipped systems)

- **WireGuard** — `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s`. Static Curve25519 keys configured on both
  peers like SSH keys; the handshake's job is "not to discover identities but to mutually prove
  possession of the corresponding private keys and derive fresh session keys with forward secrecy,"
  and it "is done based on time, and not based on the contents of prior packets, [to] deal gracefully
  with packet loss." This is our reconnect model exactly: every reconnect is a fresh, stateless
  handshake. ([wireguard.com/protocol](https://www.wireguard.com/protocol/),
  [wireguard-go handshake](https://deepwiki.com/WireGuard/wireguard-go/3.2-handshake-and-key-exchange))
- **Noise Framework** — the IK pattern definition and the KK-vs-IK trade-off above.
  ([noiseprotocol.org](https://noiseprotocol.org/noise.html))
- **Syncthing** — device identity = a long-term keypair; the **device ID is the hash of the public
  key**, persistent because it is derived from the key, and "cannot be spoofed without possessing the
  actual private key"; trust established **TOFU** at first contact. This is our `relayDeviceId`
  (§4) and our one-time-pairing-as-TOFU model.
  ([docs.syncthing.net device IDs](https://docs.syncthing.net/dev/device-ids.html))
- **Tailscale** — a persistent **node key**; the control plane "distributes a given node's public key
  to all other nodes it is allowed to communicate with," and a node re-announces its key on
  reconnect. This is our Mac **re-announcing the persisted allowlist to the relay on every Mac
  reconnect** (§4.3). ([Tailscale node keys](https://tailscale.com/docs/concepts/node-keys),
  [how it works](https://tailscale.com/blog/how-tailscale-works))

---

## 3. Credential model (what is persisted, where, surviving restart)

Exactly **two long-term keypairs** and **one allowlist**. Nothing rotates.

### 3.1 Device (iOS Keychain)

| Item | Value | Keychain attributes | Survives |
|---|---|---|---|
| `deviceStatic` | X25519 long-term keypair | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, **no biometric ACL** | app-close, phone-restart (readable after the first post-boot unlock, incl. background) |
| `macStaticPub` | Mac's X25519 public key | same | both |
| `relayURL`, `room` | transport coordinates | same | both |

`relayDeviceId` is **derived** (`BLAKE2b-256(deviceStatic.pub)`, b64u) — persisted only as a cache;
it is recomputable from the key, so it can never disagree with the key.

**Deliberate removals vs v1:** no Secure-Enclave P-256 key, no biometric, no durable bearer, no
resumption ticket, no PSK. The static X25519 key in the Keychain is the *entire* device credential —
WireGuard's model. `AfterFirstUnlock` (not `WhenUnlocked`) is required so a reconnect triggered right
after a reboot, or in the background, can read the key once the user has unlocked once.

### 3.2 Mac (`~/.eos/remote/`)

| Item | Path | Mode |
|---|---|---|
| `macStatic` | `~/.eos/remote/mac-static.key` (X25519 keypair) | `0600` |
| device allowlist (source of truth) | `~/.eos/remote/devices/<relayDeviceId>.json` = `{ deviceStaticPub, label, enrolledAt }` | `0600` |
| relay owner secret | `~/.eos/remote/relay-owner.secret` (unchanged from v1) | `0600` |

The **persisted `devices/` directory is the single source of truth** for who may connect. It survives
daemon restart (fixing v1 failure #2: there is no in-memory session state whose loss matters — a
restart just means the next handshake runs fresh, like WireGuard after a reboot).

### 3.3 Relay

The relay holds, **per room, in memory**, the set of admitted `relayDeviceId`s, rebuilt from the
Mac's `register`/`allow-add` messages. The relay is authoritative for *nothing*: its allowlist is a
cache of the Mac's persisted truth, re-announced on every Mac connect (§4.3). It never sees a static
private key, an ephemeral, or a session key. **E2E is preserved** — admission is anti-abuse, not
authentication (real auth is the IK handshake, end to end).

---

## 4. Relay admission that cannot desync

This is the direct fix for v1 failures #1 and #4.

### 4.1 The stable identity

`relayDeviceId = b64u(BLAKE2b-256(deviceStatic.pub))`. It is **derived from the static key**, so it:

- never rotates (the static key never rotates),
- is recomputable on both sides from data that already persists,
- is the same value the device presents at relay admission and the key the Mac files the device
  under.

(Optional hardening: `BLAKE2b-256(deviceStatic.pub ‖ macStatic.pub)` so the id is known only to the
two enrolled parties. Either is fine; the plain form is simpler and admission is not the security
boundary.)

### 4.2 What the device presents

At WS-upgrade / relay-join the device presents its **`relayDeviceId`** (in the same join slot v1 used
for the bearer). Because the relay is blind and admission is not authentication, this value need not
be secret — possessing it lets an attacker open a socket to the room but **not** complete the IK
handshake without `deviceStatic`'s private key. No bearer, no rotation, nothing to keep in sync.

### 4.3 How the Mac keeps the relay in sync (Tailscale-style re-announce)

- **On every Mac→relay (re)connect**, the Mac sends `register{ room, owner, allow: [all
  relayDeviceIds from ~/.eos/remote/devices/] }` — the **full** allowlist, read fresh from disk. A
  dropped relay connection or a restarted relay self-heals on reconnect.
- **On enrollment only** (the one mutation), the Mac appends one `devices/<id>.json` file and sends
  one `allow-add{ relayDeviceId }`.
- There is **no `allow-remove` churn, no per-connect rotation** — the allowlist changes only when a
  device is enrolled or explicitly revoked.

Because the admitted value is stable and re-announced from persisted truth, the allowlist **cannot
drift** from the credential it admits. The class of bug "credential present but relay says denied" is
structurally impossible.

---

## 5. The single handshake (identical every connect)

### 5.1 Steady-state connect (every open / foreground / reconnect / post-reboot)

```
1. device: read deviceStatic, macStaticPub, relayURL, room from Keychain.
2. device: open WSS to relay, join `room`, present relayDeviceId for admission.
3. device → Mac:  Noise_IK msg 1  [ e, es, s, ss ]      (s = deviceStatic.pub, encrypted)
4. Mac: look up relayDeviceId in ~/.eos/remote/devices/. MATCH deviceStatic.pub from msg 1
        against the filed value. Mismatch / not-found → AUTH_REJECTED (terminal; see §6).
5. Mac → device:  Noise_IK msg 2  [ e, ee, se ]
6. both: Split() → transport keys (forward-secret). Session live. Resume transcript-frame format
        from protocol §1.5 unchanged.
```

No tickets, no bearer issuance, no welcome-sealed secret to persist. The session is pure transport
state; if it drops, step 1 runs again — identical bytes.

### 5.2 First-time enrollment (one-time, human scans QR)

Enrollment is **not a fourth mode** — it is the same handshake plus a one-time token, run once.

QR (shown by Mac when the user arms "Remote Access") carries: `relayURL`, `room`, `macStatic.pub`,
and a **one-time enrollment token** (single-use, short TTL, e.g. 120s). When the QR is armed, the Mac
adds the enrollment token to the relay allowlist (so the not-yet-enrolled device can join) and arms
acceptance.

```
1. device: generate deviceStatic (X25519) in Keychain; compute relayDeviceId.
2. device: persist macStaticPub, relayURL, room from the QR.
3. device: open WSS, join `room` using the enrollment token for admission.
4. device → Mac:  Noise_IK msg 1  [ e, es, s, ss ]  + enrollmentToken field
5. Mac: verify enrollmentToken (valid, unexpired, unburned). Because token is present → RECORD mode:
        write ~/.eos/remote/devices/<relayDeviceId>.json = { deviceStaticPub, label, enrolledAt };
        allow-add(relayDeviceId) to relay; remove + burn the enrollment token.
6. Mac → device:  Noise_IK msg 2  [ e, ee, se ]
7. both: Split() → live. From now on the device uses §5.1 forever — identical handshake, no token.
```

The **only** difference between enrollment and a normal connect: msg 1 carries a one-time token, and
the Mac branches record (TOFU, [Syncthing-style](https://docs.syncthing.net/dev/device-ids.html))
vs match. Same crypto, same two messages, same code path with one conditional. This is the most
unified shape achievable — pairing remains a deliberate, rare, human-initiated enrollment, while
*connecting* has exactly one path.

---

## 6. Reconnect lifecycle (one path, one terminal state)

Single client entry point — call it on **app launch, foreground, network-regained, and
post-reboot-first-open**:

```
ensureConnected():
  if not enrolled (no deviceStatic / macStaticPub / relayURL in Keychain):
      state = NEEDS_PAIRING                      → show QR (one-time enrollment)
  else:
      run §5.1 handshake
        success                → state = CONNECTED
        AUTH_REJECTED (Mac)    → state = NEEDS_PAIRING   (genuine de-enrollment; show QR)
        transient (network / relay / timeout):
            retry with bounded backoff (below)
            on exhaustion       → state = DISCONNECTED    (terminal; manual "Reconnect")
```

**Bounded backoff:** exponential with jitter, e.g. 0.5s → 1 → 2 → 4 → 8 → 16 → cap 30s, **capped at N
attempts** (or a wall-clock ceiling). On exhaustion → **`DISCONNECTED`**, a single explicit terminal
state with a "Reconnect" affordance. There is **no auto-loop back into the handshake forever** and
**no auto-fallback to QR on a transient error** — those two behaviors caused v1 failure #5.

**The error taxonomy is the whole trick** — exactly two terminal outcomes, never confused:

| Outcome | Meaning | Next state |
|---|---|---|
| `AUTH_REJECTED` from the Mac | device static not in the Mac allowlist = **genuinely de-enrolled** | `NEEDS_PAIRING` (QR) |
| backoff exhausted on transient errors | relay/network down, Mac asleep | `DISCONNECTED` (manual retry) |

Network/relay failures **never** escalate to "re-pair"; only an authenticated rejection from the Mac
does. This is the line v1 blurred.

**Mac restart is a non-event:** there is no resume ticket to lose (v1 #2). The next client handshake
just runs fresh against the persisted allowlist — WireGuard-after-reboot semantics.

**Foreground re-entry resets the attempt counter**, so a user reopening the app always gets a fresh
bounded attempt sequence, satisfying the absolute requirement: open app (after close, after reboot) →
one handshake → connected, no manual step.

---

## 7. How each v1 failure is structurally eliminated

| v1 failure | v2 elimination |
|---|---|
| #1 durable bearer not in relay allowlist on reopen | admission id = stable `relayDeviceId` derived from the static key; Mac re-announces full persisted allowlist on every reconnect (§4.3) — nothing to forget to add |
| #2 resume tickets in-memory died on daemon restart | **no resume tickets at all**; connect is a stateless fresh handshake against persisted truth (§5.1, §6) |
| #3 biometric SE key broke cold-connect signing | **no Secure Enclave, no biometric, no signature**; auth is static-static DH inside IK; key is a plain Keychain X25519 readable after first unlock (§3.1) |
| #4 bearer rotation desynced relay | **nothing rotates**; the only allowlist mutation is enrollment/revocation (§4.3) |
| #5 infinite reconnect loop | one connect path, bounded backoff, two distinct terminal states; transient ≠ de-enrolled (§6) |

The surface area that produced the bug chain is gone: 3 modes → 1, ephemeral tickets → 0, rotating
bearers → 0, separately-synced allowlist → a re-announced cache of persisted truth.

---

## 8. What is reused unchanged

- **Transport:** WSS WebSocket + the self-hosted relay behind Caddy/ACME TLS
  (`wss://silver-giraffe-71764.zap.cloud/`). The relay stays a blind forwarder; E2E preserved.
- **AEAD + DH + hash primitives:** libsodium `crypto_aead_xchacha20poly1305_ietf`,
  `crypto_scalarmult` (X25519), `crypto_generichash` (BLAKE2b) — the fixture-proven byte-exact
  Swift↔Node set.
- **Transport frame format** (nonce/AAD/seq layout, `ios-remote-protocol.md` §1.5) after `Split()`.
- **Relay owner-secret / register / allow-add channel** (`manager/remote/wire.ts`,
  `RelayConnector.ts`) — kept; only the *value* announced changes (stable `relayDeviceId` instead of a
  rotating bearer hash) and the rotation/`allow-remove` churn is dropped.

---

## 9. Explicit delete list (for the rebuild — do NOT delete now)

Remove from the codebase when the rebuild lands:

**Modes & coordinators**
- The PAIR / CONNECT / RESUME three-mode split entirely.
- iOS: `ConnectCoordinator`, `ResumeCoordinator` → collapse into one `Connector` (§5.1) +
  a thin one-time `Enroller` (§5.2). `PairingCoordinator` shrinks to the enrollment wrapper.
- iOS: `AppModel` TIER-1/TIER-2 resume cascade, `needsColdConnect` flag, `resumeIfPossible()`
  multi-tier fall-through → single `ensureConnected()` (§6).

**Resume tickets (whole subsystem)**
- `manager/remote/tickets.ts` (TicketStore, families, idle/abs expiry, reuse detection,
  `invalidateFamily/All/Device`).
- `manager/remote/resume.ts` (RES-1/RES-2, PSK binders, `K_resume_ticket`).
- iOS `ResumptionTicket`, `KeychainStore.ticket`, all PSK-binder code.

**Bearer issuance / rotation**
- `handshake.ts` durable-bearer generation + rotation (the `randomBytes(32)` bearer, `bearerHashHex`,
  per-connect rotation, sealed-welcome bearer delivery).
- iOS `KeychainStore.durableBearer`.
- Relay `allow-remove` rotation churn (keep `allow-add` for enrollment + full re-`register`).

**Secure-Enclave / P-256 identity**
- iOS `DeviceIdentity` SE P-256 key, biometric ACL, `p256Sign`; `KeychainStore.deviceKeyBlob` (SE
  blob) → replaced by a plain X25519 keypair entry.
- Mac P-256 verify path for device signatures; `mac-identity.pem` (P-256) → replaced by
  `mac-static.key` (X25519). Mac signature generation (`sigS`) removed — IK authenticates the Mac via
  `se`/`ee`, no separate signature.

**Handshake legs**
- The 3-leg PAIR-1/2/3 and CONNECT-1/2/3 and 2-leg RES-1/2 message sets → one Noise_IK 2-message
  handshake (§5), enrollment adding only a one-time-token field.

Migration note: bumping the wire `v` and clearing enrolled-device state forces a one-time re-pair on
existing devices — acceptable for a pre-release feature, and the cleanest cutover.

---

## 10. Robustness justification (summary)

- **One credential, never rotating** ⇒ no propagation race between Keychain, `~/.eos`, and the relay.
- **One stateless handshake** ⇒ nothing on the Mac to lose across a restart; reconnect == first
  connect.
- **Admission id derived from the static key + re-announced from persisted truth** ⇒ the allowlist is
  a cache that self-heals, never an independent source of truth that can drift.
- **Forward secrecy** from per-session ephemerals (`ee`) even though the static credential is
  permanent.
- **Two terminal states, sharply distinguished** ⇒ no infinite loop, no spurious re-pair.
- **Precedent:** this is WireGuard's static-key + stateless-handshake model
  ([protocol](https://www.wireguard.com/protocol/)), Syncthing's hash-of-pubkey device identity with
  TOFU enrollment ([device IDs](https://docs.syncthing.net/dev/device-ids.html)), and Tailscale's
  persistent node key re-announced by the control plane
  ([node keys](https://tailscale.com/docs/concepts/node-keys)), composed over Noise IK
  ([spec](https://noiseprotocol.org/noise.html)). Every pillar is a shipped, audited system.

---

## Appendix A. KK alternative (documented, not recommended)

`Noise_KK` (`-> s` and `<- s` both pre-messages, msg sequence `-> e, es, ss` / `<- e, ee, se`)
provides the same steady-state properties as IK and never puts a static key on the wire (marginally
better identity-hiding). It is the brief's initial suggestion and is viable for steady state.

It is **not** recommended because the Mac cannot know a freshly-generated device's static key at first
pairing, so KK requires a **separate enrollment handshake** (e.g. an IK or XX exchange) purely to
register the device static — two handshake implementations instead of one. That reintroduces the
multi-path surface this redesign exists to remove. If identity-hiding of the device static key ever
becomes a hard requirement, switch steady-state to KK and keep an IK-only enrollment; until then, IK
everywhere is simpler and equally secure for this threat model.

---

## Sources

- Noise Protocol Framework (IK/KK/XK patterns, security grades): https://noiseprotocol.org/noise.html
- WireGuard protocol & cryptography (`Noise_IKpsk2`, stateless time-based handshake): https://www.wireguard.com/protocol/
- WireGuard handshake & key exchange (wireguard-go): https://deepwiki.com/WireGuard/wireguard-go/3.2-handshake-and-key-exchange
- Syncthing device IDs (hash-of-pubkey identity, TOFU): https://docs.syncthing.net/dev/device-ids.html
- Tailscale node keys (persistent key, control-plane re-announce): https://tailscale.com/docs/concepts/node-keys
- Tailscale "How it works" (key distribution / reconnect): https://tailscale.com/blog/how-tailscale-works
