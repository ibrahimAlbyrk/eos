# Plaintext Relay Protocol (mobile ↔ desktop transport v3)

Status: **DESIGN SPEC — implement against this. No code has changed.**
Supersedes: connection v2 (`docs/ios-remote-connection-v2.md`, `docs/ios-remote-protocol.md`).

Two owner-locked decisions drive this rewrite:

1. **Remove all encryption from the transport.** No AEAD, no Noise handshake, no
   device static key, no SPKI pinning of message content. Frames are plaintext
   JSON. TLS at the relay edge (Caddy/ACME) is the ONLY confidentiality layer and
   is out of scope for this protocol.
2. **Relay-only reach.** The daemon dials OUT to a self-hosted relay; the phone
   dials the same relay. There is no LAN-direct `/ws` lane in v3. (The LAN
   codepaths are on the delete list.)

The result is a **capability-URL** system: security rests on an unguessable,
high-entropy **room id** minted by the daemon, plus an optional **bearer** so a
room is not world-joinable. Anyone holding `(relayUrl, roomId, bearer)` can drive
the desktop. Treat those three values like a password.

---

## 0. Notation & encodings

- **b64url** = unpadded base64url (`A–Z a–z 0–9 - _`), RFC 4648 §5, no `=`.
- **hex** = lowercase.
- All JSON is UTF-8, one JSON object per frame, no BOM.
- "CSPRNG" = `crypto.randomBytes` (Node) / `SecRandomCopyBytes` (iOS).
- Sizes: room id ≥ 32 bytes → ≥ 43 b64url chars; clientId = 16 bytes → 22 b64url chars.

---

## 1. Threat model (what protects a room now)

With AEAD and the Noise mutual-auth removed, **the room id is the capability**.
It is a bearer secret: possession = authority to reach the desktop. The bearer is
a second, independently-checkable secret so that leaking a QR screenshot's *room*
alone (e.g. via the relay operator's logs, which see the room in the outer header)
does not by itself grant join — the relay's admission still requires the bearer.

| Concern | Mitigation in v3 |
|---|---|
| Room guessing | Room id is ≥ 32 bytes CSPRNG (≥ 256 bits) → not brute-forceable. |
| World-joinable room | Relay admits a device only if `SHA-256(bearer)` ∈ the room's allowlist (unchanged relay admission model, §4). |
| Relay operator reads content | **Accepted risk.** The relay (which you self-host) sees plaintext frames. This is the explicit trade of decision (1). TLS still protects bytes on the wire to/from the relay. |
| On-path network attacker | TLS (Caddy) between each party and the relay. Out of scope here. |
| Replay / tamper | **No longer cryptographically prevented.** `epoch`/`seq`/AAD lose their security meaning (§5.1). `correlationId` still matches replies to requests; `seq` on event frames is a gap cursor only, not a security boundary. |
| Stolen credential (lost phone) | Owner revokes by **rotating the room** (re-arm mints a new room id) or dropping the bearer from the allowlist. There is no per-device key to revoke individually in the base design; see §6.4. |

### 1.1 Room-id generation & minting

- **Who:** the **daemon**, at **arm time** (`POST /api/remote/arm`), NOT the user,
  NOT the relay, NOT stored in `config.json` by hand.
- **How:** `roomId = base64url(crypto.randomBytes(32))` — 32 bytes minimum
  (implementations MAY use more; the relay treats it as an opaque ASCII string ≤ 255 bytes).
- **Persistence:** the minted room id is written to
  `~/.eos/remote/room.id` (mode `0600`) so it survives a daemon restart and every
  reconnect uses the same room. Re-arming with an explicit "rotate" intent
  overwrites it (invalidates all existing phones → they must re-pair).
- **Charset:** because the room rides the outer envelope's `room` field as ASCII
  (`encodeEnvelope` uses `Buffer.from(room, "ascii")`), b64url is safe (all ASCII).

### 1.2 Bearer (room capability)

- **What:** an optional high-entropy secret, `base64url(crypto.randomBytes(32))`,
  minted alongside the room at arm time and stored at `~/.eos/remote/bearer.secret`
  (mode `0600`).
- **Role:** it is the value the phone presents in the relay `join` frame. The relay
  admits iff `SHA-256(bearer)` is in the room's allowlist. This is the SAME
  admission mechanism the relay already implements (`relay/admission.ts`
  `bearerAllowed`), just fed a room-capability bearer instead of a per-device
  `relayDeviceId`.
- **Optional:** the field is optional in the QR/schema to leave room for a future
  "room-id-only" mode, but the **default and recommended** posture is: always mint
  a bearer, so a room is never world-joinable even if the room id leaks to the relay
  operator. The daemon's default allowlist at register time is exactly
  `[ SHA-256(bearer) ]`.

> The **owner secret** (`relay-owner.secret`, already implemented in `wire.ts`
> `loadOwnerSecret`) is a THIRD, separate value: it is what the *daemon* presents to
> the relay to claim/own the room (`register.owner`). It is never shipped to the
> phone. Keep it as-is.

---

## 2. Pairing QR payload v3

The QR is the one human-scanned artifact. v3 drops `macStatic` (no pinned Noise
static — there is no Noise) and drops the `enroll` crypto-enrollment token (there is
no enrollment handshake; the bearer IS the join credential). It also drops the `lan`
/ `lanSpki` fields (relay-only reach).

### 2.1 Exact JSON shape

```json
{
  "v": 3,
  "typ": "eos-pair",
  "relay": "wss://relay.example.com/",
  "room": "9Qk3v...43-plus-chars...bZ",
  "bearer": "hT7m...43-plus-chars...9x",
  "exp": 1799999999
}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `v` | int `3` | ✔ | Payload version. A v2 phone MUST reject `v:3` and vice-versa. |
| `typ` | `"eos-pair"` | ✔ | Discriminator; reject otherwise. |
| `relay` | string | ✔ | Public relay endpoint, `wss://…`. The phone dials this directly. |
| `room` | b64url string | ✔ | The room capability (≥ 43 chars ⇒ ≥ 32 bytes). Routing key + capability. |
| `bearer` | b64url string | ✱ | Room-join capability presented in the relay `join`. Optional in schema; present by default. |
| `exp` | int (unix seconds) | ✔ | QR display-window close. The phone SHOULD refuse a scan past `exp`; it is a UX guard against a stale screenshot, NOT a server-enforced credential expiry — the room/bearer stay valid until re-armed. |

Notes:
- No `macStatic`, no `enroll`, no `lan`, no `lanSpki`. Enumerated for deletion in §7.
- The QR is small (well under QR capacity). No compression needed.

### 2.2 Zod schema changes — `contracts/src/remote.ts`

Replace the existing `PairingQrSchema` / `PairingQr` (currently `v: z.literal(2)`
with `macStatic` / `enroll` / `lan` / `lanSpki`) with:

```ts
// ---- Pairing QR payload v3 (plaintext relay) — produced by the Mac app --------
// Capability model: (relay, room, bearer) is the whole credential. No pinned
// static key, no enrollment token — the relay `join` bearer IS the credential.
export const PairingQrSchema = z.object({
  v: z.literal(3),
  typ: z.literal("eos-pair"),
  relay: z.string().url(),            // wss://… public relay endpoint
  room: z.string().min(43),           // b64url(>=32 bytes) — room capability + routing key
  bearer: z.string().min(43).optional(), // b64url(>=32 bytes) — room-join capability
  exp: z.number().int(),              // unix seconds — QR display window close (UX guard)
});
export type PairingQr = z.infer<typeof PairingQrSchema>;
```

(Keep `min(43)` as a cheap floor for "≥ 32 bytes b64url"; exact-length validation is
unnecessary because the relay treats these as opaque.)

### 2.3 QR generator — `manager/remote/qr.ts`

Rewrite `generatePairing()` to stop taking `identity` / `lan` / `lanSpki`, stop
minting a separate `enrollToken`, and emit the v3 shape from the already-minted room
+ bearer:

```ts
export function generatePairing(args: {
  now: number;
  relayUrl: string;
  room: string;
  bearer: string | null;
  ttlMs?: number;
}): PairingQr {
  const exp = args.now + (args.ttlMs ?? 120_000);
  const qr: PairingQr = {
    v: 3, typ: "eos-pair",
    relay: args.relayUrl, room: args.room,
    bearer: args.bearer ?? undefined,
    exp: Math.floor(exp / 1000),
  };
  PairingQrSchema.parse(qr);
  return qr;
}
```

There is no `enrollToken` return value anymore (§7 removes the pairing-enroll path).

---

## 3. Config schema simplification

### 3.1 New `RemoteConfigSchema` — `contracts/src/remote.ts`

Drop the `mode` enum (`off | lan | relay`), the `lan` block, and the user-entered
`relay.room`. Replace with a simple boolean + relay URL. The room and bearer are
**runtime-minted secrets**, not config — they live under `~/.eos/remote/`, never in
`config.json`.

```ts
// ---- config.remote (v3) — OFF by default -----------------------------------
// Relay-only. `enabled` arms the outbound relay leg. `relay.url` is the public
// wss endpoint the daemon dials and the phone dials. The room id + bearer are
// CSPRNG secrets minted by the daemon at arm time and persisted under
// ~/.eos/remote/ (room.id, bearer.secret, relay-owner.secret) — NOT config.
export const RemoteConfigSchema = z.object({
  enabled: z.boolean(),
  relay: z.object({ url: z.string().url() }).optional(),
  // Auto-expiring inactivity lease (unchanged): auto-disarm after N ms idle. 0 = never.
  inactivityLeaseMs: z.number().int().nonnegative().optional(),
  // Gateway rate limits (unchanged).
  rateLimit: z
    .object({
      perDevicePerMin: z.number().int().positive(),
      globalPerMin: z.number().int().positive(),
      pairingPerMin: z.number().int().positive(),
    })
    .partial()
    .optional(),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;
```

**Delete** `RemoteModeSchema` / `RemoteMode` from `contracts/src/remote.ts`. Every
`RemoteMode` import must go (see §7.3).

### 3.2 Defaults — `manager/shared/config.ts`

```ts
remote: {
  enabled: false,                                   // OFF by default (was: mode:"off")
  inactivityLeaseMs: envNum("EOS_REMOTE_LEASE_MS", 30 * 60 * 1000),
  rateLimit: { perDevicePerMin: 120, globalPerMin: 600, pairingPerMin: 5 },
},
```

- Remove `parseRemoteMode()` and the `EOS_REMOTE_MODE` env read.
- Optionally add `EOS_REMOTE_ENABLED` (bool) + `EOS_REMOTE_RELAY_URL` (string) for
  headless setups. `relay.url` has no default — remote stays disarmed until the
  operator provides one.
- The `remote: RemoteConfig;` field type on the config interface is unchanged (the
  type now resolves to the new shape).

### 3.3 Migration note for existing `config.json`

Existing on-disk configs carry the v2 shape:
`{ "remote": { "mode": "relay", "relay": { "url": "...", "room": "..." }, "lan": {...}, ... } }`.

The config loader merges the on-disk `remote` over defaults via
`RemoteConfigSchema.partial()`. Migration rules:

1. **`mode` → `enabled`.** On load, if `remote.mode` is present:
   `enabled = (mode === "lan" || mode === "relay")`. `mode: "off"` (or absent) ⇒
   `enabled: false`. Then drop `mode`.
2. **`relay.room` is discarded.** The old user-entered room is never reused — the
   daemon mints a fresh ≥32-byte room at the next arm. (A 16-byte v2 room is below
   the v3 entropy floor, so keeping it would be a downgrade.) Keep only
   `relay.url`.
3. **`lan` block dropped** entirely (relay-only). If a user had `mode:"lan"` and no
   `relay.url`, remote stays disarmed after migration until they set a relay URL —
   surface a one-time notice ("LAN remote is no longer supported; set a relay URL").
4. **Everything else** (`inactivityLeaseMs`, `rateLimit`) carries over unchanged.

Implement as a small `migrateRemoteConfig(raw)` shim run before
`RemoteConfigSchema.partial().parse()` in the loader, so a legacy file loads
without a hard parse error. Because v2 phones can't speak v3 anyway, existing
paired phones must re-scan a v3 QR regardless — the room rotation in rule 2 is not
an extra cost.

---

## 4. Relay room model (matches the real relay)

**No relay code changes are required** for the plaintext switch. The relay already
never inspects `data` payloads — it forwards them verbatim by `room` + `clientId` +
`dir` (`relay/RoomRegistry.ts` `routeData`). Removing AEAD only changes what those
opaque bytes *contain* (plaintext JSON vs ciphertext), which the relay is by design
blind to. The register/join/allow admission model is reused as-is.

The only relay-side edits are **comment/doc corrections** (remove "opaque
ciphertext … never decrypts" claims → "opaque application bytes") and dropping
`sodium`-derived language; there is no `sodium` import in relay code today
(admission uses Node `crypto`), so there is nothing to uninstall there (§7.4).

### 4.1 Daemon holds the room (register)

On arm (relay leg), the daemon's `RelayConnector` dials the relay and sends a
`register` (type `0x02`) control frame — **unchanged from today**:

```jsonc
// FrameType.register (0x02), JSON payload
{ "t": "register", "room": "<roomId>", "owner": "<ownerSecret>", "allow": ["<sha256(bearer) hex>"] }
```

- `room` = the minted ≥32-byte room id.
- `owner` = `relay-owner.secret` (TOFU-pins the room owner on first register;
  reconnect must present the same owner or the relay returns `OWNER_MISMATCH`).
- `allow` = the admission allowlist. In v3 this is exactly `[ sha256Hex(bearer) ]`
  (one entry). The old behavior fed `SHA-256(relayDeviceId)` per enrolled device; v3
  feeds the single room bearer instead. `admissionHashes()` in
  `manager/remote/keyring.ts` is replaced by "the bearer hash" (§7.3).
- Re-register on every (re)connect with the full allowlist (self-healing cache) —
  same pattern as today, just a 1-element list.

The relay pins `ownerHash = SHA-256(owner)` and stores `allow` as a hash set
(`relay/RoomRegistry.ts` `register`). No plaintext, no keys persisted.

### 4.2 Phone joins (join)

The phone dials the relay and sends a `join` (type `0x03`) control frame —
**unchanged wire shape**:

```jsonc
// FrameType.join (0x03), JSON payload
{ "t": "join", "room": "<roomId>", "bearer": "<bearer>" }   // apnsToken optional, unchanged
```

The relay (`RoomRegistry.join`):
1. Looks up the room; `ROOM_NOT_FOUND` if the daemon isn't registered.
2. Checks `bearerAllowed(bearer, room.allow)` (constant-time SHA-256 membership);
   `BEARER_DENIED` if the bearer isn't the room capability.
3. Assigns a fresh 16-byte `clientId`, records `clientId → device socket`.
4. Sends a `joined` ack (type `0x04` relayctl) to **both** the phone and the daemon:

```jsonc
// FrameType.relayctl (0x04), JSON payload — sent to phone AND daemon
{ "t": "joined", "clientId": "<b64url(16 bytes)>", "room": "<roomId>" }
```

The daemon's `onJoined(clientId)` spins up a per-client session; the phone learns the
`clientId` it must stamp on every outgoing frame. **The phone MUST NOT send any
`data` frame before the join-ack arrives** (relay routing needs the assigned clientId).

If the room is missing/bearer wrong, the relay returns a `error` (type `0x06`):

```jsonc
{ "t": "error", "code": "ROOM_NOT_FOUND" | "BEARER_DENIED" | "ROOM_FULL" | "FRAME_TOO_LARGE" | "RATE_LIMITED", "message": "…" }
```

### 4.3 Routing (data)

`data` frames (type `0x01`) are routed by the outer header only:

- `dir = c2s (0x00)` → forwarded to the room's **daemon** socket.
- `dir = s2c (0x01)` → forwarded to `room.devices[clientId]`.

The payload (now plaintext JSON, §5) is forwarded verbatim; the relay never parses it.
`routeData` returns `ROOM_NOT_FOUND` if there is no target — the daemon/phone treats a
routing error as "peer offline".

### 4.4 Outer envelope (frozen binary header — kept)

The relay's demux depends on the 13-byte binary outer header
(`relay/envelope.ts`), so v3 **keeps the outer envelope byte layout unchanged** on
both ends (`manager/remote/envelope.ts`, `ios/.../Transport/Envelope.swift`):

```
ver(1)=0x01  type(1)  dir(1)  epoch(1)  seq(8 BE)  roomLen(1)  room(roomLen)  clientId(16)  payload(..)
```

What changes:
- For `type = data (0x01)`, `payload` is **UTF-8 JSON** (the inner frame, §5),
  not AEAD ciphertext.
- `epoch` and `seq` in the outer header **lose their cryptographic role**. They are
  no longer AEAD nonce inputs or AAD. The daemon and phone SHOULD set `epoch = 0`
  and MAY set `seq = 0` on `data` frames (or keep a monotonic counter purely for
  logging). Neither side validates them for replay anymore. `Envelope.aad()` and the
  `Nonce` construction are deleted (§7).
- `MAX_ENVELOPE_BYTES = 5 MiB` unchanged.

Keeping the header frozen means **the relay package is untouched** and old/new
envelope codecs stay byte-compatible on the control-frame path.

---

## 5. Frame / envelope format WITHOUT AEAD

Two layers:

- **Outer envelope** — §4.4, binary, relay-visible. Unchanged bytes.
- **Inner frame** — the `payload` of a `type = data` envelope. In v3 this is
  **plaintext UTF-8 JSON**, one object, tagged by `t`. This replaces the sealed
  ciphertext. No handshake frames exist anymore (no `hs`, no `resume`, no Noise
  msg-1/msg-2, no `challenge`, no step-up).

The application dialogue is unchanged in shape from v2's *decrypted* inner frames —
only the sealing is gone. Client→server frames are validated by `ClientFrameSchema`
(`contracts/src/remote.ts`); server→client frames are emitted by `WsBridge`.

### 5.1 What is removed from the frame model

- `hello` frame's `resumptionTicket` / `resumeEphemeralPub` (crypto resume) — the
  bearer/room IS the steady credential; no ticket. `lastContentId` MAY stay as a
  resume cursor (§6.2) but is optional.
- `stepUp` on control frames, the `challenge` server frame, the `StepUp` schema and
  the whole `/stepup/*` path — deleted. Every control is dispatched at full
  capability (there is no SE key to step up with, and the v2 model already granted
  all caps per session).
- `epoch` / `seq` as replay/gap security — `seq` survives ONLY as the event-push
  ordering cursor (server→client, §5.4), not a security boundary.

### 5.2 Client → server frames

All ride as the plaintext JSON `payload` of a `data (0x01)` envelope, `dir = c2s`.

#### 5.2.1 `join` — handled by the RELAY, not the daemon

See §4.2. This is a relay control frame (type `0x03`), not a `data` frame. Listed
here for lifecycle completeness. There is no separate app-level "hello handshake" —
after the relay join-ack, the phone is immediately live and may issue controls.

#### 5.2.2 `hello` (optional resume hint)

Sent once by the phone right after join-ack, to request a snapshot / declare a resume
cursor. Optional — a phone MAY skip it and just issue GETs (as `AppModel.bootstrap`
does today).

| Field | Type | Req | Meaning |
|---|---|---|---|
| `t` | `"hello"` | ✔ | Discriminator. |
| `lastContentId` | int \| null | ✱ | Highest server `seq` the phone has applied; asks the daemon to snapshot if a gap exists. Absent ⇒ full snapshot. |

```jsonc
{ "t": "hello", "lastContentId": 4213 }
```

Zod (`HelloFrameSchema`, simplified — drop `resumptionTicket` / `resumeEphemeralPub`):

```ts
export const HelloFrameSchema = z.object({
  t: z.literal("hello"),
  lastContentId: z.number().int().nonnegative().nullable().optional(),
});
```

#### 5.2.3 `control` (tunneled REST request)

| Field | Type | Req | Meaning |
|---|---|---|---|
| `t` | `"control"` | ✔ | Discriminator. |
| `correlationId` | uuid string | ✔ | Matches the `reply`/`asset` that answers this request. |
| `method` | `GET`\|`POST`\|`PUT`\|`DELETE` | ✔ | HTTP verb dispatched into the existing route handlers. |
| `path` | string | ✔ | Route path incl. query, e.g. `/workers/w-1/events?limit=120`. |
| `body` | string | ✱ | **Opaque JSON string** (not a nested object). GET ⇒ `"{}"`; absent ⇒ treated as `"{}"`. Kept as a string so the daemon dispatches the exact transmitted bytes. |

```jsonc
{ "t": "control", "correlationId": "0f8c…", "method": "POST", "path": "/workers/w-1/message", "body": "{\"text\":\"hi\"}" }
```

Zod (`ControlFrameSchema`, simplified — drop `stepUp`):

```ts
export const ControlFrameSchema = z.object({
  t: z.literal("control"),
  correlationId: z.string().uuid(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string(),
  body: z.string().optional(),
});
```

#### 5.2.4 `ka` (client keepalive)

| Field | Type | Req | Meaning |
|---|---|---|---|
| `t` | `"ka"` | ✔ | Discriminator. |
| `ts` | int | ✔ | Client clock ms (informational; may be 0). |

```jsonc
{ "t": "ka", "ts": 0 }
```

`KaFrameSchema` unchanged.

`ClientFrameSchema` = discriminated union of `hello | control | ka` (unchanged
membership; the per-frame shapes lost their crypto fields).

### 5.3 Client → server: the `join` relay frame vs `data` frames

To be unambiguous about which socket a frame is destined for:

| Purpose | Envelope `type` | Consumed by | Payload |
|---|---|---|---|
| Register room | `0x02 register` | relay | JSON `{t:"register",…}` |
| Join room | `0x03 join` | relay | JSON `{t:"join",…}` |
| Join-ack | `0x04 relayctl` | phone + daemon | JSON `{t:"joined",…}` |
| Allowlist mutate | `0x04 relayctl` | relay | JSON `{t:"allow-add"/"allow-remove",…}` |
| App control/data | `0x01 data` | peer (daemon/phone) | **plaintext inner-frame JSON** (§5.2 / §5.4) |
| Relay error | `0x06 error` | phone/daemon | JSON `{t:"error",code,…}` |
| Relay keepalive | `0x05 ka` | relay (tolerated) | — |

### 5.4 Server → client frames

All ride as the plaintext JSON `payload` of a `data (0x01)` envelope, `dir = s2c`,
routed to `room.devices[clientId]`. Emitted by `WsBridge` (`ServerFrame` union) /
the control dispatcher. Drop the `challenge` variant.

#### 5.4.1 `event` (bus fan-out push)

| Field | Type | Meaning |
|---|---|---|
| `t` | `"event"` | Discriminator. |
| `seq` | int | Monotonic per-bridge content cursor. Lets the phone detect a gap → send `hello`/re-snapshot. Ordering only, not security. |
| `reason` | string | EventBus topic verbatim. |
| `ts` | int | Server ms. |
| `payload` | any | Topic payload. |

```jsonc
{ "t": "event", "seq": 4214, "reason": "worker:change", "ts": 1799999999000, "payload": { "workerId": "w-1" } }
```

#### 5.4.2 `patch` (resource upsert/remove)

| Field | Type | Meaning |
|---|---|---|
| `t` | `"patch"` | Discriminator. |
| `seq` | int | Content cursor (as above). |
| `resource` | string | `"workers"` \| `"pending"` \| … |
| `op` | `"upsert"`\|`"remove"` | Mutation kind. |
| `data` | any | Resource row (or id for remove). |

#### 5.4.3 `snapshot` (full state)

| Field | Type | Meaning |
|---|---|---|
| `t` | `"snapshot"` | Discriminator. |
| `seq` | int | Cursor at snapshot time. |
| `workers` | array | Worker rows. |
| `pending` | array | Pending rows. |

#### 5.4.4 `reply` (control response, correlationId-matched)

| Field | Type | Meaning |
|---|---|---|
| `t` | `"reply"` | Discriminator. |
| `correlationId` | string | Echoes the originating `control`. |
| `status` | int | Captured HTTP status. `2xx` ⇒ success. |
| `body` | any | Response JSON (may be null). |

```jsonc
{ "t": "reply", "correlationId": "0f8c…", "status": 200, "body": { "ok": true } }
```

#### 5.4.5 `asset` (binary route read, out-of-band base64)

Unchanged from v2 (`AssetFrameSchema`). Binary route reads (images/pdf/raw) can't
ride the JSON `reply` (utf-8 round-trip corrupts bytes), so they travel as base64.
`correlationId`-addressed like `reply`.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"asset"` | Discriminator. |
| `correlationId` | string | Matches the originating control. |
| `status` | int | Captured HTTP status. |
| `mime` | string | Content type for the WebView. |
| `bytesB64` | string | base64 of the raw bytes. |

#### 5.4.6 `ka` (server keepalive)

```jsonc
{ "t": "ka", "ts": 1799999999000 }
```

#### 5.4.7 `error` (app-level error / auth reject)

| Field | Type | Meaning |
|---|---|---|
| `t` | `"error"` | Discriminator. |
| `code` | enum | See §5.5. |
| `message` | string? | Human detail. |
| `correlationId` | string? | Present ⇒ fails a specific pending control; absent ⇒ session-level. |

```jsonc
{ "t": "error", "code": "CAP_DENIED", "message": "route refused", "correlationId": "0f8c…" }
```

**Auth-reject semantics:** in v3 there is no per-device de-enrollment handshake. A
phone becomes unauthorized only when the **relay** rejects its `join` with
`BEARER_DENIED` (owner rotated the room/bearer) or `ROOM_NOT_FOUND` (daemon disarmed
/ room rotated). The phone treats `BEARER_DENIED` / `ROOM_NOT_FOUND`-after-known-good
as **NEEDS_PAIRING** (show QR); network/`ROOM_NOT_FOUND`-while-daemon-restarting as
**transient** (backoff). There is no daemon-emitted cleartext `AUTH_REJECTED` data
frame anymore — the auth verdict comes from the relay join step.

### 5.5 Error-code enum — `contracts/src/remote.ts`

Drop the crypto codes (`DECRYPT_FAIL`, `REPLAY`, `AUTH_FAILED`, `SEQ_GAP` as a
security gap). Keep app-level and relay-surfaced codes:

```ts
export const REMOTE_ERROR_CODES = [
  "BAD_VERSION",     // envelope ver mismatch (kept: outer header still versioned)
  "AUTH_REJECTED",   // relay BEARER_DENIED / room gone → NEEDS_PAIRING
  "CAP_DENIED",      // route not permitted remotely
  "ROUTE_REFUSED",   // route in the REFUSED set
  "RATE_LIMITED",
  "INTERNAL",
  "FRAME_TOO_LARGE",
] as const;
```

Relay error codes (`relay/errors.ts`) are unchanged:
`ROOM_NOT_FOUND | BEARER_DENIED | OWNER_MISMATCH | ROOM_FULL | FRAME_TOO_LARGE | RATE_LIMITED`.

---

## 6. Connection lifecycle

One connect path, used identically on first connect and every reconnect. The
credential is the persisted `(relayUrl, room, bearer)` — there is **no handshake**
beyond the relay join.

### 6.1 First connect (after pairing)

1. Scan v3 QR → validate (`typ==eos-pair`, `v==3`, `exp>now`) → extract
   `(relay, room, bearer)`.
2. Open `wss://relay/` (TLS; public CA, no SPKI pinning).
3. Send `join` (type `0x03`) with `{room, bearer}`.
4. Receive join-ack (`{t:"joined", clientId}`) → store the clientId for this session.
5. Persist `(relayUrl, room, bearer)` to Keychain (§8).
6. Go live: start the receive loop + keepalive; optionally send `hello`, then GET
   `/workers` + `/pending` (or await snapshot) to seed the store.

No Noise, no msg-1/msg-2, no enrollment token. The phone is live the instant the
join-ack lands.

### 6.2 Resume / reconnect

Identical to first connect minus the QR scan — read `(relayUrl, room, bearer)` from
Keychain and run steps 2–6. Because there is no handshake, "resume" and "connect"
are the same code path (this collapses the v2 `Connector.run()` choreography to: open
→ join → live).

- On a dropped socket while foregrounded → bounded backoff (1s→60s) then reconnect.
- A fresh join always gets a NEW `clientId` from the relay (the old device entry was
  dropped on socket close); the phone must use the new clientId. There is no
  cross-reconnect session state to restore on the wire — the store re-seeds via
  snapshot/GETs. `lastContentId` in `hello` lets the daemon send a snapshot only if
  the phone missed events.

### 6.3 Disconnect / unpair

- **Disconnect (temporary):** close the socket; keep Keychain creds. Next foreground
  resumes.
- **Unpair (explicit):** close the socket and delete all Keychain items
  (`relay.url`, `relay.room`, `relay.bearer`). Next launch → NEEDS_PAIRING (show QR).

### 6.4 Background / foreground

- **Background:** intentionally drop the socket (mark `intentionalStop` so the
  delegate's `connected=false` doesn't trigger auto-reconnect). Relay drops the
  device entry on close.
- **Foreground:** reset backoff, run the resume path (§6.2). "Open app → connected"
  holds because the creds are readable from the Keychain
  (`AfterFirstUnlockThisDeviceOnly`, no biometric ACL) even right after a reboot.

### 6.5 Revocation

Rotating authority is an owner action on the desktop:
- **Rotate room** (re-arm with rotate intent): mints a new `room.id` (+ optionally a
  new bearer), re-registers. Every existing phone's next `join` → `BEARER_DENIED` /
  `ROOM_NOT_FOUND` → NEEDS_PAIRING. This is the coarse "revoke all phones" control.
- **Bearer drop:** `allow-remove` the bearer hash → same effect. (With a single
  room bearer, per-device revocation is not available in the base design; if
  per-device revocation is later needed, mint one bearer per phone at pair time and
  put each hash in the allowlist — the relay already supports a multi-entry allowlist
  and `allow-add`/`allow-remove`.)

---

## 7. Explicit DELETE list

Everything below is removed or gutted. Grouped by area.

### 7.1 iOS — crypto files (DELETE entirely)

All under `ios/EosRemoteKit/Crypto/` **except `Bytes.swift`**, which holds
non-crypto wire encoders (`hex`, `fromHex`, `b64u`, `fromB64u`, `ascii`) used
across the transport — **KEEP `Bytes.swift`**.

- `ios/EosRemoteKit/Crypto/CryptoSuite.swift` — libsodium AEAD / kx / BLAKE2b. DELETE.
- `ios/EosRemoteKit/Crypto/Noise.swift` — Noise_IK state machine. DELETE.
- `ios/EosRemoteKit/Crypto/NoiseIdentity.swift` — `relayDeviceId`, steady/enroll
  payloads. DELETE.
- `ios/EosRemoteKit/Crypto/DeviceStatic.swift` — device X25519 static keypair (the
  removed credential). DELETE.
- `ios/EosRemoteKit/Crypto/Nonce.swift` — 24-byte AEAD nonce + the `Direction` enum.
  DELETE the file, **but** `Direction` (c2s/s2c) is still needed by the outer
  envelope. **Move `Direction` into `Transport/Envelope.swift`** (or a small
  `Transport/Direction.swift`) before deleting `Nonce.swift`.

> Note `Bytes.swift`'s header comment references "protocol §0"; keep the file, it is
> pure encoding.

### 7.2 iOS — AEAD sealing paths (GUT, keep file)

- `ios/EosRemoteKit/Transport/SessionState.swift` — remove `kC2sFinal`, `kS2cFinal`,
  `sessionTH`, `epoch`, `isResumed`, `sealOutgoing`, `openIncoming`, `acceptRxSeq`,
  `nextTxSeq` (all AEAD/replay). Reduce to: `room`, `clientId`, and two trivial
  codecs `frameToEnvelope(json)` → `data` envelope (plaintext payload, `dir=c2s`,
  `epoch=0`, `seq=0`) and `envelopeToJSON(env)` → the raw `payload`. (Or fold these
  into `WSConnection` and delete `SessionState` — implementer's call; the class no
  longer holds secrets.)
- `ios/EosRemoteKit/Transport/WSConnection.swift`:
  - Remove the `ConnectionMode.lan(spkiSHA256:)` case → relay-only (`.relay(bearer:)`
    or just carry the bearer directly).
  - Remove `pinningDelegate` / `SPKIPinningDelegate` wiring.
  - `routeEnvelope`: replace `session.openIncoming` + `acceptRxSeq` with a plain
    `ServerFrame.decode(env.payload)`.
  - `sealOutgoing` calls (`sendControl`, `sendKeepalive`) → build a plaintext `data`
    envelope from the JSON directly.
  - Remove the `challenge` handling branch in `dispatch` (no step-up).
- `ios/EosRemoteKit/Transport/TLSPinning.swift` — `SPKIPinningDelegate`. DELETE
  (relay uses public-CA TLS, no pinning).
- `ios/EosRemoteKit/Transport/Envelope.swift` — **KEEP** the outer codec (relay
  needs it), but DELETE `aad(...)` / `aad()` (AEAD AAD) and host the `Direction`
  enum here (moved from `Nonce.swift`). Update the comment that calls the payload
  "AEAD ciphertext" → "plaintext inner-frame JSON".

### 7.3 iOS — pairing/model/step-up (GUT/rewrite)

- `ios/EosRemoteKit/Pairing/Connector.swift` — DELETE the Noise choreography. Rewrite
  to: open → send relay `join{room,bearer}` → await join-ack → go live. Remove
  `deviceStatic`, `macStaticPub`, `Mode.enroll`, `NoiseInitiator`, `writeMessage1`,
  `readMessage2`, `NoiseIdentity` refs. `Mode` collapses to a single connect
  (bearer-carrying).
- `ios/EosRemoteKit/Pairing/QRPayload.swift` — rewrite to v3: drop `macStatic`,
  `enroll`, `lan`, `lanSpki`, `macStaticData`, `lanSpkiData`, `missingTransport`
  (relay is required); require `relay`; add optional `bearer`; `v == 3`.
- `ios/EosRemoteKit/Pairing/KeychainStore.swift` — remove `deviceStaticSec` and
  `macStaticPub` item keys; keep `relayURL`, `room`; add `bearer`. (Class KEPT — §8.)
- `ios/EosRemoteKit/StepUp/CapabilityTier.swift` — the `.high` tier existed to gate
  SE step-up, which is gone. Options: (a) DELETE the whole `StepUp/` folder and stop
  consulting tiers client-side; or (b) keep `RouteTier` ONLY for the `refused` set
  (routes never sent remotely) and drop the `high`/`low`/step-up distinction. Recommend
  (b): keep `refused` as a client-side guard, delete `high`/`low` arrays + the
  `.high`/`.low` cases if unused. The `StepUp` folder name should be renamed or its
  step-up intent removed.
- `ios/EosRemoteKit/Models/InnerFrame.swift`:
  - DELETE `ChallengeFrame`, `StepUpField`.
  - Remove the `.challenge` case from the `ServerFrame` enum + its `decode` arm.
  - `HelloFrame`: drop `resumptionTicket`, `resumeEphemeralPub`.
  - `ControlFrame`: drop `stepUp`.

### 7.4 iOS — tests & project

- `ios/EosRemoteKitTests/NoiseFixtureTests.swift` — DELETE (no Noise, no fixture).
- `ios/EosRemoteKitTests/MessageNormalizerTests.swift` — KEEP (no crypto; transcript
  render).
- `ios/project.yml` — DELETE the `Sodium` SPM package block (`packages.Sodium`) and
  the `- package: Sodium` dependency from BOTH the `EosRemoteKit` target and the
  `EosRemoteKitTests` target. Remove `Clibsodium`/`Sodium` imports wherever they
  appeared (only in the deleted `Crypto/*`). Optionally drop
  `INFOPLIST_KEY_NSFaceIDUsageDescription` (no step-up / Face ID).

### 7.5 iOS — AppModel (rewrite connect/pair/resume)

`ios/EosRemote/App/AppModel.swift`:
- Remove `deviceStatic: NoiseDH.Keypair?`, all `DeviceStatic` / `NoiseIdentity` refs.
- `startPairing`: drop `macStaticPub`/`enrollToken`/`DeviceStatic.loadOrCreate`;
  persist `(relayURL, room, bearer)`; open relay with the bearer; run the collapsed
  join connector.
- `resumeIfPossible`: read `(relayURL, room, bearer)` from Keychain (no device key,
  no pinned Mac key); run the join connector; keep the transient/authRejected/backoff
  branches (authRejected now = relay `BEARER_DENIED`/room-gone).
- `disconnect`: delete `relay.url`, `relay.room`, `relay.bearer` (drop
  `deviceStaticSec`, `macStaticPub`).
- The `kill`/`spawn`/`decision` "high-risk verb" comments about "no per-action
  step-up" stay true (there never is now); no code change beyond removing step-up
  imports.

### 7.6 Desktop — crypto files (DELETE entirely)

- `manager/remote/crypto.ts` — sodium-native X25519 / BLAKE2b / XChaCha20 AEAD. DELETE.
- `manager/remote/noise.ts` — Noise_IK responder state machine. DELETE.
- `manager/remote/identity.ts` — `relayDeviceId`, `parsePayload1`, steady/enroll
  payloads. DELETE.
- `manager/remote/session.ts` — `RemoteSessionCodec` (per-session AEAD seal/open).
  DELETE; replace its role with a trivial plaintext framer (JSON ↔ `data` envelope).
- `manager/remote/sodium-native.d.ts` — sodium-native typings. DELETE.
- `manager/remote/gen-fixture.ts` + `manager/remote/scripts/` (fixture generation) —
  DELETE (no cross-impl Noise fixture to generate).
- `docs/vectors/ios-remote-v2/` (golden Noise vectors) — DELETE (no longer referenced
  once `NoiseFixtureTests` + `gen-fixture.ts` are gone).

### 7.7 Desktop — gateway/keyring/pairing (GUT/rewrite)

- `manager/remote/gateway.ts`:
  - DELETE `NoiseResponder`, `RemoteSessionCodec`, `parsePayload1` usage,
    `HS_WIRE_VERSION`, `onHandshake`, `sendCleartext`, `rejectAuth`, `SESSION_CAPS`
    (or reduce to a single always-on cap set), `PairingProvider`,
    `admitted()`/`admissionHashes` LAN admission, `createLanGateway`,
    `mountWsGateway` (relay-only — no LAN `/ws`).
  - `GatewayConnection` becomes: on `onJoined(clientId)`, immediately create a live
    `RemoteSession` whose `send(frame)` = `encode a plaintext data envelope` and
    whose incoming path = `parse envelope → ClientFrameSchema → ControlDispatcher`.
    No handshake state.
  - Drop `identity`, `keyring`, `pairing`, `onEnrolled` from `GatewayDeps`.
- `manager/remote/keyring.ts`:
  - DELETE `MacIdentity` (Mac static X25519 identity — no Noise).
  - DELETE `DeviceKeyring` per-device records + `admissionHashes()` +
    `record`/`findByStaticPub`/`revoke`/`list` (no per-device enrollment). Replace
    with a tiny `RoomSecrets` helper that mints/loads `room.id` + `bearer.secret`
    (§1.1/§1.2). `sha256Hex` can move to a shared util or the new helper.
  - `~/.eos/remote/devices/` directory + `mac-static.key` are no longer written;
    document that stale files are ignored (don't delete user data by hand per repo
    rules).
- `manager/remote/pairing.ts` — DELETE the enroll-token holder (`PairingManager`,
  `matchToken`, `enrollTokenHash`, `burn`). Pairing is now "mint QR from the already-
  armed room+bearer"; no server-held one-time token. `armPairing` just returns
  `generatePairing({relayUrl, room, bearer, now})`.
- `manager/remote/qr.ts` — rewrite per §2.3 (no `identity`/`lan`/`enrollToken`).
- `manager/remote/wire.ts`:
  - Remove the `mode` switch; gate on `config.remote.enabled` + `relay.url`.
  - Remove `MacIdentity` / `DeviceKeyring` / `PairingManager` construction and the
    LAN branch (`createLanGateway`, `onUpgrade`). Relay-only.
  - Mint/load room + bearer (new `RoomSecrets`), pass `room` to the connector, set
    `allow: () => [ sha256Hex(bearer) ]`.
  - `armPairing(opts)` → `generatePairing({...})`; drop the enroll-hash `allowAdd`.
  - `PairArmOptions` loses `lan`/`lanSpki`/`relay.room`; `RemoteGatewayHandle` loses
    `onUpgrade`.
  - `RelayConnector.ts` — KEEP (transport dial/reconnect/register). Its `allow`
    callback now returns the 1-element bearer-hash list; `sendData` payloads are
    plaintext. Remove any comment claiming payloads are "ciphertext … relay never
    sees plaintext" → "plaintext … relay (self-hosted) can see content."
- `manager/remote/envelope.ts` — KEEP the outer codec (relay contract). Update the
  header comment ("opaque AEAD ciphertext" → "plaintext inner-frame JSON") and DELETE
  the AEAD-oriented `epoch`/`seq` semantics from docs (fields stay in the header for
  wire-compat but are set to 0).
- `manager/remote/dispatch.ts` — KEEP (`ControlDispatcher` routes into existing
  handlers) but remove any step-up (`stepUp`) verification and the `DispatchSession`
  cap plumbing tied to `highrisk` if present.
- `manager/remote/tiers.ts` — analogous to iOS `CapabilityTier`: keep the `REFUSED`
  set (routes never remote-reachable), drop the HIGH/step-up tier logic.
- `manager/remote/controller.ts` — mostly unchanged, but the persistent `/ws` upgrade
  listener is dead in relay-only mode. Remove the `onUpgrade` delegation (always
  relay). `RemoteMode` import removed; `reconcile()` returns `{ enabled, armed }`.
- `manager/routes/remote.ts` — `buildArmOptions` loses the `mode`/`lan` branches
  (relay-only, reads `relay.url`); `/api/remote/status` returns `{ enabled, armed }`.
- `manager/remote/__tests__/` — DELETE `noise-fixture.test.ts`, `codec.test.ts`,
  `dispatch-qr.test.ts` (QR v2 shape); REWRITE `wire.test.ts`,
  `relay-connector.test.ts`, `gateway-ws.test.ts`, `tiers.test.ts` for the new
  shapes; `asset-frame.test.ts` stays (asset frame unchanged).

### 7.8 Contracts

`contracts/src/remote.ts`:
- REWRITE `PairingQrSchema` → v3 (§2.2).
- REWRITE `RemoteConfigSchema` → `{ enabled, relay:{url}, … }` (§3.1); DELETE
  `RemoteModeSchema` / `RemoteMode`.
- DELETE `StepUpSchema` / `StepUp`; remove `stepUp` from `ControlFrameSchema`;
  remove `resumptionTicket`/`resumeEphemeralPub` from `HelloFrameSchema`.
- TRIM `REMOTE_ERROR_CODES` (§5.5).
- `AssetFrameSchema`, `KaFrameSchema`, `ClientFrameSchema` membership unchanged.

### 7.9 Desktop crypto dependency (`sodium-native`)

- `sodium-native` is imported ONLY by `manager/remote/{crypto,noise,gen-fixture}.ts`
  + `sodium-native.d.ts` (all deleted §7.6). After deletion, remove `sodium-native`
  from `manager/package.json` dependencies and re-lock. **The relay has no
  `sodium`/`sodium-native` dependency** (its admission uses Node's built-in
  `crypto`), so nothing to uninstall in `relay/`.

---

## 8. iOS Keychain contents after the change

Service `dev.eos.remote`, accessibility `AfterFirstUnlockThisDeviceOnly`, **no**
biometric ACL (so background/post-reboot resume can read them). Exactly three items,
all part of the room capability:

| Key (`kSecAttrAccount`) | Value | Notes |
|---|---|---|
| `relay.url` | UTF-8 string | `wss://relay…/` from the QR. |
| `relay.room` | UTF-8 string (b64url) | The ≥32-byte room capability. |
| `relay.bearer` | UTF-8 string (b64url) | The room-join capability. Optional (absent only if a future room-id-only mode is used). |

**Removed items (delete on migration / unpair):**
- `device.static.sec` — the X25519 device static secret (no device key anymore).
- `mac.static.pub` — the pinned Mac Noise static (no Noise).

`KeychainStore` keeps `set`/`get`/`delete` and the three well-known keys above; its
`deviceStaticSec` / `macStaticPub` constants are removed and `bearer` is added.

---

## 9. Summary of wire decisions

- **Capability = room id.** ≥32-byte CSPRNG b64url, minted by the daemon at arm,
  persisted `~/.eos/remote/room.id`. Optional bearer (≥32-byte CSPRNG) is the relay
  `join` credential so a room isn't world-joinable.
- **QR v3:** `{ v:3, typ, relay, room, bearer?, exp }`. No `macStatic`, no `enroll`,
  no LAN fields.
- **Config:** `remote.enabled: boolean` + `remote.relay.url`. No `mode`, no
  user-entered room. Room/bearer are runtime secrets, not config. Migrate
  `mode→enabled`, discard old room.
- **Relay unchanged.** It already routes `data` verbatim by room+clientId+dir and
  admits by SHA-256(bearer) hash-membership. Plaintext is transparent to it; only
  comments change.
- **Outer envelope frozen** (13-byte binary header) for relay compat; `data`
  payload is now plaintext UTF-8 JSON; `epoch`/`seq`/AAD lose crypto meaning
  (set to 0, not validated).
- **Inner frames:** client `hello`/`control`/`ka`; server
  `event`/`patch`/`snapshot`/`reply`/`asset`/`ka`/`error`. No `hs`/`resume`/`challenge`/
  step-up.
- **Lifecycle:** open → relay `join{room,bearer}` → join-ack(clientId) → live. Resume =
  same path from Keychain creds. No handshake. Revoke = rotate room/bearer.
- **Deleted:** all iOS `Crypto/*` (except `Bytes.swift`), AEAD in `Transport/*`, TLS
  pinning, Noise connector, step-up; the swift-sodium SPM dep; desktop
  `crypto.ts`/`noise.ts`/`identity.ts`/`session.ts`/`gen-fixture.ts`/`sodium-native.d.ts`,
  `MacIdentity`/`DeviceKeyring`/`PairingManager`, the LAN gateway, `sodium-native`
  from `manager/package.json`, and the Noise golden vectors + fixture tests.
