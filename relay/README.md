# eos-relay

A small, standalone **dumb unicast forwarder** for Eos iOS remote control
(self-hosted relay). It routes purely on a cleartext outer envelope and forwards
opaque `data` payloads it never parses. In protocol v3 those payloads are
**plaintext inner-frame JSON** (transport encryption was removed) — the relay,
which you self-host, can therefore see content, so **TLS at the relay edge
(Caddy/ACME) is the only confidentiality layer**. The room id + bearer are the
capability: admission is `SHA-256(bearer)` hash-membership, unchanged.

## What it does

- One plain-`ws` listener (TLS/ACME is owned by a fronting reverse proxy — see Deploy).
- In-memory room registry: `register` (Mac claims a room) / `join` (device admitted).
- Hash-allowlist admission: stores only `SHA-256(bearer)`; constant-time membership.
- Per-device unicast routing keyed by a relay-assigned 16-byte `clientId`.
- Phone push through APNs with the operator's own key, asked for only by the room's Mac (see Push).

It does **no payload crypto** (SHA-256 only, for admission) and is
**protocol-version-independent**: it never parses inner frames, so Eos protocol
changes (including the v2→v3 plaintext switch) require no relay upgrade.

## Run locally

```bash
npm install
npm start            # binds 127.0.0.1:3000 by default
npm test             # node strip-types test suite
```

### Config (env)

| Var | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | bind host (`0.0.0.0` inside Docker, fronted by Caddy) |
| `RELAY_PORT` | `3000` | bind port |
| `RELAY_ROOM_OWNER_HASH` | _(unset)_ | optional operator pre-pin of the room-owner hash; unset = trust-on-first-register (TOFU) |
| `RELAY_MAX_ROOM_DEVICES` | `32` | per-room device cap (`ROOM_FULL` past it) |
| `RELAY_HEARTBEAT_MS` | `30000` | WS ping cadence; a socket that misses one pong is terminated (half-open peers dropped within ~2 intervals) |
| `RELAY_VAULT_DB` | `./vault.db` | sync vault SQLite file (`/data/vault.db` in Docker, on the `eos-relay-data` volume) |
| `RELAY_VAULT_MAX` | `16` | how many vaults may exist; a new one past it is `503 {"error":"vault limit"}` |
| `RELAY_VAULT_MAX_BYTES` | `268435456` | per-vault blob bytes (256 MiB); a put past it is `507` |
| `APNS_KEY` | _(unset)_ | path to the operator's APNs `.p8` key |
| `APNS_KEY_ID` | _(unset)_ | the key's id |
| `APNS_TEAM_ID` | _(unset)_ | the Apple team that owns the key and signs the phone app |
| `APNS_BUNDLE_ID` | _(unset)_ | the phone app's bundle id (`apns-topic`) |

With any `APNS_*` value unset, push sends nothing and answers `reason: "not-configured"`.

`GET /health` → `200 {"ok":true,"rooms":N}` for proxy/Docker health checks.

## Vault (Eos sync)

Plain HTTP next to the ws listener, backing Mac↔Mac sync.
It stores **opaque blobs only**: record keys are HMACs and data is AES-GCM ciphertext
sealed on the Macs — the relay never sees ids, names or content. It only orders writes
(one monotonic `seq` per vault) and refuses stale ones. SQLite via `node:sqlite`.

| | |
|---|---|
| `GET /vault/v1/:vault/changes?since=N&wait=S&limit=L` | `200 {head, entries:[{key,seq,data}], more}` — entries with `seq > N`, oldest first (`limit` default 100, max 1000); when empty, held up to `S` s (max 25) for a put |
| `PUT /vault/v1/:vault/records/:key` `{baseSeq, data}` | compare-and-swap: `200 {seq}` · `409 {entry}` when the record's seq isn't `baseSeq` (`entry: null` if it doesn't exist) · `413` blob > 8 MiB · `507` vault quota |

`:vault` is 32 hex chars, `:key` 64; `data` is base64. Every call carries
`Authorization: Bearer <16–128 chars [A-Za-z0-9_-]>`: the first request for a vault pins
`SHA-256(token)` (TOFU, as rooms do); a different token is `403`, none `401`.

## Push

The relay wakes a closed phone app with a notification, sent with the operator's APNs key
(ES256 provider token over HTTP/2). Only the room's Mac may ask, and only for a closed kind
and a count: the payload comes from a fixed table, so nothing written by a user, an agent or a
service reaches Apple.

- **Tokens.** A phone's `join` carries `apnsToken` and `apnsEnv` (`"sandbox"` or
  `"production"`; a phone that sends none is `production`). The relay keeps them in the SQLite
  file (`RELAY_VAULT_DB`, table `push_tokens`, one row per room and `SHA-256(bearer)`), so
  they outlive the phone's socket. A token goes when the Mac removes that device
  (`allow-remove`, or a `register` whose allowlist leaves it out) or when Apple calls it gone
  (410, or 400 `BadDeviceToken` / `Unregistered`). The room's owner hash is kept beside them,
  so after a relay restart the room still belongs to the same Mac.
- **Over the socket.** The Mac sends relayctl `{t:"push", room, kind, count}` on its owner
  socket (any other socket gets `OWNER_MISMATCH`, a bad kind or count `BAD_REQUEST`) and
  gets relayctl `{t:"push-result", sent, failed, gone, reason?}`.
- **Over HTTP**, while the Mac's socket is closed: `POST /push/v1/:room` with
  `Authorization: Bearer <room owner secret>` and `{kind, count}` → `200 {sent, failed, gone,
  reason?}` · `400` bad body · `401` bad bearer · `404` unknown room · `429` throttled.
- **Kinds:** `needs_you`, `run_failed`, `routine_paused`, `ready`, `test`. The payload is
  `{"aps":{"alert":{"title-loc-key":"push.<kind>.title","loc-key":"push.<kind>.body","loc-args":["<count>"]},"badge":<count>,"sound":"default","thread-id":"<kind>"},"m":"<8 hex>"}`,
  `m` being the first 8 hex of `SHA-256(room)` so a phone paired with two Macs knows which.
- **Rate:** 30 a minute and 300 an hour per room; past it the socket answers
  `reason: "throttled"` and HTTP `429`. `reason: "not-configured"` means no APNs key is set.
- The relay logs no room ids, tokens, bearers or payloads.

## Deploy (coexists with an existing Caddy + Docker on 80/443)

The relay binds loopback `127.0.0.1:3000` and is fronted by the **existing Caddy**, which
keeps owning TLS/ACME on 80/443. The relay URL stays `wss://<your-domain>:443` — the relay
itself is URL-agnostic and carries no TLS code.

Sketch (a subdomain block; the actual Caddyfile/ufw/systemd edits are an infra/deploy
step, owned outside this package):

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy upgrades WebSocket connections transparently. Ship the relay as a tiny Docker image
(`Dockerfile` here) on the same Docker network, or as a bare `node` process under systemd.
