// Relay runtime config from env. The relay is URL-agnostic: it binds a plain ws
// listener (TLS/ACME is owned by the fronting Caddy, design §7.1/§7.3).

// The operator's own APNs key (07 G19). Null when any of the four values is unset: push then
// answers `not-configured` and nothing reaches Apple.
export type ApnsConfig = { keyPath: string; keyId: string; teamId: string; bundleId: string };
export type ApnsOrigins = { production: string; sandbox: string };

export type RelayConfig = {
  host: string;
  port: number;
  // Optional operator pre-pin of the room-owner hash. When set, a room's first
  // registration MUST present an owner whose SHA-256 equals this; otherwise the
  // first valid registration pins the owner (TOFU). You self-host this relay, and
  // in protocol v3 it forwards PLAINTEXT frames (no E2E), so a relay compromise
  // reveals content — TOFU is acceptable for a self-hosted box (protocol §1).
  ownerHashPin: string | null;
  maxRoomDevices: number;
  // WS ping cadence. A socket that misses one pong is terminated, so a half-open
  // peer (suspended phone, sleeping Mac, dead NAT) is dropped within 2 intervals.
  heartbeatMs: number;
  // Sync vault (vault/): SQLite file, how many vaults may exist (each is TOFU-pinned by
  // whoever asks first, so the cap is what keeps a public relay from hosting strangers),
  // and the per-vault / per-blob size limits.
  vaultPath: string;
  maxVaults: number;
  maxVaultBytes: number;
  maxBlobBytes: number;
  // Hook inboxes (hooks/): how many may exist, for the same reason as vaults.
  maxHookInboxes: number;
  apns: ApnsConfig | null;
  // Tests point these at a local fake.
  apnsOrigins: ApnsOrigins;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    host: env.RELAY_HOST ?? "127.0.0.1",
    port: Number(env.RELAY_PORT ?? 3000),
    ownerHashPin: env.RELAY_ROOM_OWNER_HASH ? env.RELAY_ROOM_OWNER_HASH.toLowerCase() : null,
    maxRoomDevices: Number(env.RELAY_MAX_ROOM_DEVICES ?? 32),
    heartbeatMs: Number(env.RELAY_HEARTBEAT_MS ?? 30_000),
    vaultPath: env.RELAY_VAULT_DB ?? "./vault.db",
    maxVaults: Number(env.RELAY_VAULT_MAX ?? 16),
    maxVaultBytes: Number(env.RELAY_VAULT_MAX_BYTES ?? 256 * 1024 * 1024),
    maxBlobBytes: 8 * 1024 * 1024,
    maxHookInboxes: Number(env.RELAY_HOOK_INBOX_MAX ?? 16),
    apns: loadApns(env),
    apnsOrigins: { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" },
  };
}

function loadApns(env: NodeJS.ProcessEnv): ApnsConfig | null {
  const { APNS_KEY: keyPath, APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId } = env;
  return keyPath && keyId && teamId && bundleId ? { keyPath, keyId, teamId, bundleId } : null;
}
