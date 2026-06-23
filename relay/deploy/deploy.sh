#!/usr/bin/env bash
# Deploy / redeploy eos-relay to the VPS, coexisting with the existing Docker + Caddy
# stack. Idempotent: safe to re-run for upgrades. Never restarts the existing stack —
# it only attaches a new container to the existing network and graceful-reloads Caddy.
#
# Usage: ./deploy.sh
# Requires: SSH access to the server as root with the key below.
set -euo pipefail

KEY="${RELAY_SSH_KEY:-$HOME/Downloads/zap-hosting.pri}"
HOST="${RELAY_SSH_HOST:-root@185.249.197.74}"
REMOTE_DIR="/opt/eos-relay"
NETWORK="obsidian-sync_obsidian"   # the existing Caddy/couchdb compose network
CADDYFILE="/opt/obsidian-sync/Caddyfile"
CADDY_CTR="obsidian-caddy"
RELAY_HOST_NAME="silver-giraffe-71764.zap.cloud"

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)
SRC="$(cd "$(dirname "$0")/.." && pwd)"   # the relay/ package root

echo ">> shipping relay/ (excluding node_modules, deploy) -> $HOST:$REMOTE_DIR"
"${SSH[@]}" "$HOST" "mkdir -p $REMOTE_DIR"
tar czf - -C "$SRC" \
  --exclude='node_modules' --exclude='deploy' --exclude='._*' \
  package.json package-lock.json tsconfig.json Dockerfile README.md \
  server.ts envelope.ts admission.ts errors.ts apns.ts config.ts RoomRegistry.ts __tests__ \
  | "${SSH[@]}" "$HOST" "tar xzf - -C $REMOTE_DIR && find $REMOTE_DIR -name '._*' -delete"

echo ">> build image + (re)create container on network $NETWORK (no host port published)"
"${SSH[@]}" "$HOST" "
  set -e
  cd $REMOTE_DIR
  docker build -t eos-relay:latest .
  docker rm -f eos-relay 2>/dev/null || true
  docker run -d --name eos-relay --restart unless-stopped --network $NETWORK eos-relay:latest
"

echo ">> ensure Caddy route exists, then graceful reload (no stack restart)"
"${SSH[@]}" "$HOST" "
  set -e
  if ! grep -q '$RELAY_HOST_NAME' $CADDYFILE; then
    cp -a $CADDYFILE $CADDYFILE.bak.\$(date +%s)
    printf '\n# eos-relay (iOS remote control relay)\n%s {\n\treverse_proxy eos-relay:3000\n}\n' '$RELAY_HOST_NAME' >> $CADDYFILE
  fi
  docker exec $CADDY_CTR caddy validate --config /etc/caddy/Caddyfile
  docker exec $CADDY_CTR caddy reload --config /etc/caddy/Caddyfile
"

echo ">> verify"
"${SSH[@]}" "$HOST" "docker exec $CADDY_CTR wget -qO- http://eos-relay:3000/health && echo"
curl -sf --max-time 15 "https://$RELAY_HOST_NAME/health" && echo
echo ">> done. public relay URL: wss://$RELAY_HOST_NAME/"
