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

# Operator settings on the server (APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, RELAY_HOOK_INBOX_MAX, …),
# written by hand once; see README.md. The .p8 key sits beside it and is mounted read-only.
ENV_FILE="$REMOTE_DIR/relay.env"
APNS_DIR="$REMOTE_DIR/apns"

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new)
SRC="$(cd "$(dirname "$0")/.." && pwd)"   # the relay/ package root

echo ">> shipping relay/ (excluding node_modules, deploy) -> $HOST:$REMOTE_DIR"
"${SSH[@]}" "$HOST" "mkdir -p $REMOTE_DIR"
tar czf - -C "$SRC" \
  --exclude='node_modules' --exclude='._*' \
  package.json package-lock.json tsconfig.json Dockerfile README.md deploy/Caddyfile.snippet \
  server.ts envelope.ts admission.ts errors.ts config.ts RoomRegistry.ts vault push hooks __tests__ test-env.mjs \
  | "${SSH[@]}" "$HOST" "tar xzf - -C $REMOTE_DIR && find $REMOTE_DIR -name '._*' -delete"

echo ">> build image + (re)create container on network $NETWORK (no host port published; data on volume eos-relay-data)"
"${SSH[@]}" "$HOST" "
  set -e
  cd $REMOTE_DIR
  mkdir -p $APNS_DIR && chmod 700 $APNS_DIR
  [ -f $ENV_FILE ] || install -m 600 /dev/null $ENV_FILE
  docker build -t eos-relay:latest .
  docker rm -f eos-relay 2>/dev/null || true
  docker run -d --name eos-relay --restart unless-stopped --network $NETWORK \\
    -v eos-relay-data:/data -v $APNS_DIR:/apns:ro --env-file $ENV_FILE eos-relay:latest
"

echo ">> ensure Caddy route exists, then graceful reload (no stack restart)"
"${SSH[@]}" "$HOST" "
  set -e
  if ! grep -q '$RELAY_HOST_NAME' $CADDYFILE; then
    cp -a $CADDYFILE $CADDYFILE.bak.\$(date +%s)
    sed -n '/^$RELAY_HOST_NAME {/,/^}/p' $REMOTE_DIR/deploy/Caddyfile.snippet >> $CADDYFILE
  fi
  # The hook and push paths need their body limits; an older block without them is reported, not rewritten.
  grep -q 'path /hooks/' $CADDYFILE || echo '!! the relay block lacks the /hooks/ and /push/ paths: replace it with Caddyfile.snippet (README.md)'
  docker exec $CADDY_CTR caddy validate --config /etc/caddy/Caddyfile
  docker exec $CADDY_CTR caddy reload --config /etc/caddy/Caddyfile
"

echo ">> verify"
"${SSH[@]}" "$HOST" "docker exec $CADDY_CTR wget -qO- http://eos-relay:3000/health && echo"
curl -sf --max-time 15 "https://$RELAY_HOST_NAME/health" && echo
# An unknown hook answers 404 from the relay itself, so /hooks/ reaches it through Caddy.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "https://$RELAY_HOST_NAME/hooks/v1/00000000000000000000000000000000/00000000000000000000000000000000")
[ "$code" = 404 ] && echo ">> /hooks/ reaches the relay" || echo "!! /hooks/ answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "https://$RELAY_HOST_NAME/push/v1/x")
[ "$code" = 401 ] && echo ">> /push/ reaches the relay" || echo "!! /push/ answered $code"
echo ">> done. public relay URL: wss://$RELAY_HOST_NAME/"
