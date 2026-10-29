#!/usr/bin/env bash
# Deploy / redeploy the eos-updates static server on the relay's VPS, next to the
# existing Docker + Caddy stack. Idempotent: safe to re-run. It (re)creates only
# the eos-updates container and graceful-reloads the main Caddy — the existing
# stack is never modified beyond one appended site block, never restarted.
#
# Usage: ./deploy.sh
# Env:   UPDATES_SSH_HOST (default: the zap-server ssh alias), UPDATES_HOST_NAME.
set -euo pipefail

HOST="${UPDATES_SSH_HOST:-zap-server}"
SITE="${UPDATES_HOST_NAME:-updates.ibrahimalbyrk.dev}"
SERVER_IP="185.249.197.74"
REMOTE_DIR="/opt/eos-updates"
NETWORK="obsidian-sync_obsidian"   # the existing Caddy/couchdb compose network
CADDYFILE="/opt/obsidian-sync/Caddyfile"
CADDY_CTR="obsidian-caddy"
HERE="$(cd "$(dirname "$0")" && pwd)"

SSH=(ssh -o BatchMode=yes "$HOST")

echo ">> ship config -> $HOST:$REMOTE_DIR"
"${SSH[@]}" "mkdir -p $REMOTE_DIR/www/stable $REMOTE_DIR/www/releases $REMOTE_DIR/www/packs $REMOTE_DIR/www/notes"
"${SSH[@]}" "cat > $REMOTE_DIR/Caddyfile" < "$HERE/Caddyfile"

echo ">> (re)create container eos-updates on network $NETWORK (no host port; files read-only)"
"${SSH[@]}" "
  set -e
  docker rm -f eos-updates >/dev/null 2>&1 || true
  docker run -d --name eos-updates --restart unless-stopped --network $NETWORK \
    -v $REMOTE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v $REMOTE_DIR/www:/srv:ro \
    caddy:2 >/dev/null
"

echo ">> verify inside the network"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  "${SSH[@]}" "docker exec $CADDY_CTR wget -qO- http://eos-updates/health" >/dev/null 2>&1 && break
  sleep 1
done
"${SSH[@]}" "docker exec $CADDY_CTR wget -qO- http://eos-updates/health" && echo

# The site block only once the name resolves: without DNS, Caddy would keep
# failing ACME for it in the background. Asks the zone's own name server, as the
# ACME CA does — a public resolver may still cache the name's earlier absence.
nameserver="$(dig +short NS "${SITE#*.}" | head -1)"
resolved="$(dig +short A "$SITE" @"${nameserver:-1.1.1.1}" | tail -1)"
if [ "$resolved" != "$SERVER_IP" ]; then
  echo ">> $SITE does not point at $SERVER_IP yet (got '${resolved:-nothing}')."
  echo "   Add the A record (DNS only), then re-run this script to route it."
  exit 0
fi

echo ">> ensure the Caddy route for $SITE, then graceful reload (no stack restart)"
"${SSH[@]}" "
  set -e
  if ! grep -q '^$SITE ' $CADDYFILE; then
    cp -a $CADDYFILE $CADDYFILE.bak.\$(date +%s)
    printf '\n# eos-updates (in-app updates: signed manifests + chunk packs, static)\n%s {\n\treverse_proxy eos-updates:80\n}\n' '$SITE' >> $CADDYFILE
  fi
  docker exec $CADDY_CTR caddy validate --config /etc/caddy/Caddyfile
  docker exec $CADDY_CTR caddy reload --config /etc/caddy/Caddyfile
"

# Pinned to the server's address: this Mac's resolver may still cache the name's
# earlier absence for a while.
echo ">> verify https://$SITE (first request waits for the certificate)"
for _ in $(seq 1 30); do
  curl -sf --max-time 10 --resolve "$SITE:443:$SERVER_IP" "https://$SITE/health" && { echo; echo ">> done: https://$SITE/"; exit 0; }
  sleep 2
done
echo "error: https://$SITE/health did not answer" >&2
exit 1
