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
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    host: env.RELAY_HOST ?? "127.0.0.1",
    port: Number(env.RELAY_PORT ?? 3000),
    ownerHashPin: env.RELAY_ROOM_OWNER_HASH ? env.RELAY_ROOM_OWNER_HASH.toLowerCase() : null,
    maxRoomDevices: Number(env.RELAY_MAX_ROOM_DEVICES ?? 32),
  };
}
