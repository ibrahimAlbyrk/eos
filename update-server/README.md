# eos-updates (static update server)

Serves in-app updates — signed pointers, manifests, chunk packs, release
notes — from the relay's VPS (`zap-server`, 185.249.197.74), next to the
existing Docker + Caddy stack. Plan: `docs/updates/00-UPDATES-PLAN.md`.

## Public URL

    https://updates.ibrahimalbyrk.dev/

`GET /health` → `ok`. Needs an A record `updates` → 185.249.197.74 (Cloudflare,
DNS only).

## Shape

- **Own container.** `eos-updates` runs the `caddy:2` image as a plain file
  server on the `obsidian-sync_obsidian` network, with `/opt/eos-updates/www`
  mounted read-only at `/srv` and its config from `Caddyfile` here. No host
  port; the main Caddy (`obsidian-caddy`) reaches it as `eos-updates:80`.
- **Why not the main Caddy directly:** it sees only its own mounts, and adding
  one means editing and recreating the `obsidian-sync` compose project, which
  the relay deploy never does either.
- **TLS** stays with the main Caddy (ACME on 80/443); the site block is
  appended once (a timestamped `.bak` is kept) and Caddy is graceful-reloaded.
- **Cache headers:** `stable/*` is `no-cache`; `releases/*`, `packs/*`,
  `notes/*` are immutable — so the Cloudflare proxy can be switched on later.

## Layout

    /opt/eos-updates/
      Caddyfile
      www/
        stable/<platform>.json                  signed pointer (written last)
        releases/<version>/<platform>.manifest.json.zst
        packs/<platform>/<version>.pack
        notes/<version>.md

## Deploy / redeploy

    ./deploy.sh

Ships the config, recreates only `eos-updates`, and — once the DNS record
resolves — adds the route and reloads Caddy. Without the record it stops after
the in-network check; re-run it once the record exists.
