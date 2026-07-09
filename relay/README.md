# eos-relay

A small, standalone **dumb unicast forwarder** for Eos iOS remote control
(self-hosted relay). It routes purely on a cleartext outer envelope and forwards
opaque `data` payloads it never parses. In protocol v3 those payloads are
**plaintext inner-frame JSON** (transport encryption was removed) — the relay,
which you self-host, can therefore see content, so **TLS at the relay edge
(Caddy/ACME) is the only confidentiality layer**. The room id + bearer are the
capability: admission is `SHA-256(bearer)` hash-membership, unchanged.

See `docs/mobile-redesign/01-plaintext-relay-protocol.md` §4–§5 for the
authoritative contract.

## What it does

- One plain-`ws` listener (TLS/ACME is owned by a fronting reverse proxy — see Deploy).
- In-memory room registry: `register` (Mac claims a room) / `join` (device admitted).
- Hash-allowlist admission: stores only `SHA-256(bearer)`; constant-time membership.
- Per-device unicast routing keyed by a relay-assigned 16-byte `clientId`.
- Opt-in APNs egress — a **no-op stub** unless the operator supplies their own APNs key.

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

`GET /health` → `200 {"ok":true,"rooms":N}` for proxy/Docker health checks.

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
