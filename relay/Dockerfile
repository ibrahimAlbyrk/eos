# Tiny relay image. The relay does SHA-256 admission only (no E2E crypto), so it has
# a single pure-JS dependency (ws) and needs no native build.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY envelope.ts admission.ts errors.ts apns.ts config.ts RoomRegistry.ts server.ts ./
COPY vault/ ./vault/

# Sync vault database (node:sqlite, unflagged since Node 22.13) on a named volume.
RUN mkdir -p /data
ENV RELAY_VAULT_DB=/data/vault.db
VOLUME /data

ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=3000
EXPOSE 3000

# TLS/ACME is owned by the fronting Caddy; the relay speaks plain ws on its bind port.
CMD ["node", "--experimental-strip-types", "--no-warnings", "server.ts"]
