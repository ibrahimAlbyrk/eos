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
- `Caddyfile.snippet` — the site block appended to `/opt/obsidian-sync/Caddyfile`.
- `eos-relay.service` — bare-host systemd alternative (see its header for caveats).

## Redeploy / upgrade

    RELAY_SSH_KEY=~/Downloads/zap-hosting.pri ./deploy.sh

Rebuilds the image, recreates only the `eos-relay` container, and graceful-reloads Caddy.

## Manual equivalents (what deploy.sh runs on the server)

    # ship relay/ (no node_modules) to /opt/eos-relay, then:
    cd /opt/eos-relay
    docker build -t eos-relay:latest .
    docker run -d --name eos-relay --restart unless-stopped \
      --network obsidian-sync_obsidian eos-relay:latest
    # append Caddyfile.snippet to /opt/obsidian-sync/Caddyfile, then:
    docker exec obsidian-caddy caddy validate --config /etc/caddy/Caddyfile
    docker exec obsidian-caddy caddy reload   --config /etc/caddy/Caddyfile
