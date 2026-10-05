// Relay runtime config from env. The relay is URL-agnostic: it binds a plain ws
// listener (TLS/ACME is owned by the fronting Caddy, design §7.1/§7.3).

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
  };
}
