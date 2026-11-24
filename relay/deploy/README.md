# eos-relay deploy (VPS, coexisting with existing Docker + Caddy)

Deploys the relay to `ibrahim-albyrk.zap.cloud` (185.249.197.74, Debian 13, Node 22)
**alongside** the existing workloads, touching none of them.

## Public URL

    wss://silver-giraffe-71764.zap.cloud/

`GET https://silver-giraffe-71764.zap.cloud/health` → `{"ok":true,"rooms":N}`.

## Why this shape

- **Hostname (subdomain, not path).** Of the candidate names, only `obsidian.ibrahimalbyrk.dev`
  (in use) and `silver-giraffe-71764.zap.cloud` (the box's own PTR / zap.cloud name)
  publicly resolve to the server. `ibrahim-albyrk.zap.cloud` is just the server's
  `/etc/hostname` and does **not** resolve in public DNS, and there is no wildcard. So the
  relay gets the dedicated, resolvable `silver-giraffe-71764.zap.cloud` with its own real
  ACME cert — cleaner than a path prefix and isolated from the obsidian/couchdb site.
- **Docker, not systemd.** The existing Caddy runs *inside* a container
  (`obsidian-caddy`) on the private `obsidian-sync_obsidian` bridge network. The relay
  runs as its own container **joined to that same network**, so Caddy reaches it by name
  (`eos-relay:3000`). No host port is published, so it cannot collide with `syncmusic-app`
  (which owns host `:3000`). `--restart unless-stopped` gives boot/crash recovery. (A
  bare-host systemd alternative is in `eos-relay.service`, but the containerized Caddy
  makes Docker the clean choice here.)
- **No TLS in the relay.** Caddy keeps owning ACME/TLS on 80/443; `reverse_proxy` upgrades
  WebSocket transparently.

## Coexistence guarantees

- The existing `obsidian-sync` compose project is **not** modified and **not** recreated.
  The relay is a standalone `docker run` that only *attaches* to the existing network.
- Caddy is **graceful-reloaded** (`caddy reload`), never restarted; the Caddyfile is only
  appended to (a timestamped `.bak` is kept).
- Verified after deploy: `obsidian.ibrahimalbyrk.dev` (HTTP 401, couchdb),
  `185.249.197.74.sslip.io` (HTTP 200), and all four pre-existing containers stayed up at
  their original uptimes. Nothing on 80/443 was taken over.

## Files

- `deploy.sh` — idempotent ship + build + run + Caddy-route + graceful-reload + verify.
- `Caddyfile.snippet` — the site block appended to `/opt/obsidian-sync/Caddyfile`, with the
  `/hooks/` and `/push/` paths.
- `eos-relay.service` — bare-host systemd alternative (see its header for caveats).

## Push, hooks and the data volume (the operator's steps)

The relay holds three things that must outlive a container: the sync vault, the phones' push
tokens with each room's owner hash, and the hook inboxes with their sealed events. All three
are tables of one SQLite file, `/data/vault.db`, on the named volume `eos-relay-data`
(`docker volume inspect eos-relay-data`). Back the volume up before an upgrade that changes the
image's Node version. The vault quota stays `RELAY_VAULT_MAX_BYTES=268435456` (256 MiB): the
app shares that much among its sync domains.

Done once, by hand, on the server; `deploy.sh` never writes these files:

1. **The APNs key.** In the Apple developer account of team `MW57K22389` (Certificates, IDs &
   Profiles › Keys), create a key with Apple Push Notifications service enabled and download
   its `AuthKey_<KEYID>.p8` (Apple lets you download it once). Copy it to the server:
   `scp AuthKey_<KEYID>.p8 root@185.249.197.74:/opt/eos-relay/apns/AuthKey.p8`, then
   `chmod 600 /opt/eos-relay/apns/AuthKey.p8` there.
2. **The settings.** Write `/opt/eos-relay/relay.env` (mode 600), one `NAME=value` a line:

       APNS_KEY=/apns/AuthKey.p8
       APNS_KEY_ID=<the key's 10-character id>
       APNS_TEAM_ID=MW57K22389
       APNS_BUNDLE_ID=<the phone app's bundle id>
       RELAY_HOOK_INBOX_MAX=16
       RELAY_VAULT_MAX_BYTES=268435456

   With any `APNS_*` line missing the relay sends no push and answers `not-configured`; the
   rest works.
3. **Caddy.** The relay's site block must be the one in `Caddyfile.snippet` (it adds the
   `/hooks/` and `/push/` paths with their body limits). `deploy.sh` appends it only when no
   block for the host exists, and says so when an older block lacks the paths: then replace the
   block in `/opt/obsidian-sync/Caddyfile` by hand (keep the `.bak`), and run
   `docker exec obsidian-caddy caddy validate --config /etc/caddy/Caddyfile` and
   `docker exec obsidian-caddy caddy reload --config /etc/caddy/Caddyfile`.
4. **Deploy:** `RELAY_SSH_KEY=~/Downloads/zap-hosting.pri ./deploy.sh`. Its last lines check
   that `/health` answers, that `/hooks/` reaches the relay (404 for an unknown hook) and that
   `/push/` does (401 without a bearer).
5. **Check push end to end:** pair the TestFlight phone app, then press Settings › Remote ›
   "Send a test notification" in Eos. "Sent to 1 phone" is the proof; `not-configured` means a
   step above is missing, a 403 from Apple (`failed`) a wrong key id, team or bundle id.

**Resetting a room's owner.** The relay keeps each room's owner hash for good (`push_rooms`), so
a Mac that lost `~/.eos/remote/relay-owner.secret` but kept its room id is refused. To let it
claim the room again, delete that one row (the room id is in `~/.eos/remote/room.id` on that
Mac), then restart the container:

    docker exec eos-relay node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync('/data/vault.db').prepare('DELETE FROM push_rooms WHERE room = ?').run(process.argv[1])" '<room id>'
    docker restart eos-relay

## Redeploy / upgrade

    RELAY_SSH_KEY=~/Downloads/zap-hosting.pri ./deploy.sh

Rebuilds the image, recreates only the `eos-relay` container, and graceful-reloads Caddy.

## Manual equivalents (what deploy.sh runs on the server)

    # ship relay/ (no node_modules) to /opt/eos-relay, then:
    cd /opt/eos-relay
    docker build -t eos-relay:latest .
    docker run -d --name eos-relay --restart unless-stopped \
      --network obsidian-sync_obsidian -v eos-relay-data:/data \
      -v /opt/eos-relay/apns:/apns:ro --env-file /opt/eos-relay/relay.env eos-relay:latest
    # append Caddyfile.snippet to /opt/obsidian-sync/Caddyfile, then:
    docker exec obsidian-caddy caddy validate --config /etc/caddy/Caddyfile
    docker exec obsidian-caddy caddy reload   --config /etc/caddy/Caddyfile
