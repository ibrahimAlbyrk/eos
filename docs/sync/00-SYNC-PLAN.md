# Sync — implementation plan

One user, several Macs, one profile. The user's own data (profile, memories, pages,
prompt templates, worker definitions) follows them to every Mac they join, and keeps
flowing while the other Mac is off. Builds on `docs/profile/00-PROFILE-PLAN.md` (which
listed "sync across Macs" as a v1 non-goal) and the relay (`relay/`).

## Decisions (confirmed)

- **Account = a sync key, not a server login.** The first Mac creates a 32-byte secret;
  every other Mac joins by pasting the key (Settings › Sync). Whoever holds the key is
  "the account". No email/password, no auth server.
- **Works while the other Mac is off.** The relay keeps an end-to-end encrypted **vault**
  per key; Macs push their changes to it and pull everyone else's. The relay only ever
  sees opaque blobs under opaque keys.
- **Synced:** profile (all but `dreaming`), avatar, memories (active / suggested /
  dismissed tombstones), pages, `~/.eos/templates` (+ assets), `~/.eos/workers`.
- **Device-local:** `profile.dreaming`, dream runs/watermarks, chats, state.db, config,
  peer identity, accounts. A dream's proposals are memories, so they sync like any other.
- **Control pairing ≠ same person.** Peering (Machines) stays as is; sync is its own key.

## Shape

```
Mac A daemon ──push/pull──▶ relay vault (ciphertext) ◀──push/pull── Mac B daemon
     │                                                                 │
 SyncService (core) ── SyncDomain adapters ── the existing one write path per domain
```

### Relay vault (`relay/vault/`)

HTTP next to the ws forwarder (Caddy already proxies every path). SQLite (`node:sqlite`)
on a Docker volume (`/data/vault.db`).

| | |
|---|---|
| `GET  /vault/v1/:vault/changes?since=N&wait=S` | entries with seq > N (paged, `more`), long-polls up to S s when empty |
| `PUT  /vault/v1/:vault/records/:key` `{baseSeq, data}` | compare-and-swap: 200 `{seq}` · 409 `{entry}` when the record moved on |

- `vault` = HKDF(secret, "vault-id"), `Authorization: Bearer` HKDF(secret, "auth").
  First request pins sha256(auth) (TOFU, as rooms do); a wrong token is 403.
- One monotonic `seq` per vault; a record row keeps its latest blob + seq.
- Limits: blob ≤ 8 MiB, vault ≤ 256 MiB, `RELAY_VAULT_MAX` vaults (default 16).

### Crypto (`infra/src/sync/`)

- `recordKey = HMAC(k_key, domain + "/" + id)` (hex) — the relay never sees ids.
- `data = AES-256-GCM(k_enc, envelope)`, random 96-bit nonce, AAD = recordKey (a blob
  can't be replayed under another record).
- Envelope (plaintext inside): `{ v:1, domain, id, changedAt, device, deleted?, data? }`.
- Sync key string: `eos-sync1.<base64url(relayUrl)>.<base64url(secret)>`.

### Engine (`core/src/services/SyncService.ts`)

Ports: `SyncVault` (pull / put), `SyncCrypto` (recordKey / seal / open / hash),
`SyncStateStore` (index + cursor + conflicts), `SyncDomain[]`, `Clock`.

Local state (`~/.eos/sync/state.json`): `cursor` + an **index** per record
`{ seq, hash, changedAt, deleted? }` — `hash` is the hash of the *local* record as last
synced. Records carry no sync fields, so no file format changes.

- **Detect** — snapshot every domain, hash each record: no index entry or a different
  hash ⇒ dirty; in the index but gone locally ⇒ a delete to push. Runs on a debounced
  bus event (`pages:change`, `profile:change`, `user-memory:change`) and every 30 s
  (templates/workers are hand-edited files with no events).
- **Push** — seal + `PUT` with `baseSeq = index.seq`. 409 ⇒ resolve against the returned
  entry, then retry.
- **Pull** — long-poll `changes?since=cursor`; apply each entry unless the local record is
  dirty (→ resolve). After applying, index the new local hash so the change event it fires
  is not pushed back (no echo).
- **Resolve** (rare: the same record edited on two Macs before either synced) — newer
  `changedAt` wins; the loser is never dropped: it is written to
  `~/.eos/sync/conflicts/<domain>/<id>.<stamp>.json`. A local record never indexed
  (first join) counts as `changedAt = 0`: **joining adopts the account's version**, the
  Mac's own copy goes to conflicts. Identical content is not a conflict.
- Single-flight: one sync pass at a time.

### Domains (`SyncDomain`: `list() / read(id) / apply(id, data) / remove(id)`)

| domain | id | payload | write path |
|---|---|---|---|
| `profile` | `identity` `language` `work` `style` `instructions` `sharing` `budgetTokens` `onboardedAt` | that field | `UserProfileService.applySynced` |
| `avatar` | `avatar` | `{ext, b64}` | `UserProfileService.setAvatar / clearAvatar` |
| `memory` | `um-…` | memory minus `rev` | `UserMemoryService.applySynced / removeSynced` (`by: "sync"`) |
| `page` | `pg-…` | page minus `rev`, `agentId` (a chat link is local; kept on apply) | `PageService.applySynced / removeSynced` |
| `template` | name | md text + `assets/<name>/*` (b64) | file dir, soft delete to `.trash` |
| `worker` | name | md text | file dir, soft delete to `.trash` |

Profile fields are separate records, so two Macs editing different groups both win.
`identity.avatar` rides the avatar record, not `identity`.

### Projects across Macs

Memory `scope.path` and page `project` are absolute paths and differ per Mac. On the wire
they become a **project key**: the normalised `origin` remote (`github.com/owner/repo`),
or `path:<abs>` without one. On apply the key resolves to the local folder with the same
remote (projects.json folders + agent folders); unresolved ⇒ the sender's path, remembered
so the next push keeps the key. `ProjectKeyResolver` port, adapter in manager.

### Daemon + API

- `SyncService` wired in `container.ts`, started in `daemon.ts`; identity in
  `~/.eos/sync/identity.json` (0600). `sync` added to `USER_DATA_ENTRIES`.
- Routes (all `LOCAL_ONLY` — a controlling Mac never sees the key; writes ui-token):
  `GET /api/sync` status · `POST /api/sync/create` · `POST /api/sync/join {key}` ·
  `GET /api/sync/key` · `POST /api/sync/now` · `POST /api/sync/leave` (data stays).
- SSE `sync:change` (status). Memory-suggestion banners skip `by: "sync"` — a Mac
  announces only what it produced.

### UI (Settings › Sync)

Off: one line of what it does + **Create** / **Join with key**. On: "Synced · 2 min ago"
(or the error), **Copy key**, **Sync now**, **Leave**. Nothing else.

## Phases

1. ✅ Relay vault + tests; Docker volume in `deploy.sh`.
2. ✅ Contracts + crypto + engine + state store + tests.
3. ✅ Domains (profile, avatar, memory, page, template, worker) + project keys + tests.
4. ✅ Daemon wiring, routes, SSE, notifications.
5. ✅ Settings › Sync.
6. Deploy the relay (`relay/deploy/deploy.sh`), create on one Mac, join on the other.

As built: a profile group at its empty default counts as absent (a fresh Mac has
nothing to conflict with; a tombstone resets the group). The vault answers a write to
a record it never stored with 409 `{entry:null}` — the client rewrites it from seq 0.

## Later

Join through the peer invite ("this is my Mac too") instead of pasting the key ·
dream evidence that opens the other Mac's chat (`/h/<host>/`) · near-duplicate memory
review after a first join · tombstone GC on the relay.
