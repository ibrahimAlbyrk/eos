// Room capability secrets (plaintext relay v3, §1.1/§1.2). With the Noise mutual-
// auth and the per-device keyring removed, a room is reached by an unguessable
// high-entropy room id (the capability) plus an optional bearer the relay admits
// on. Both are CSPRNG secrets minted by the daemon at arm time and persisted:
//
//   ~/.eos/remote/room.id        base64url(randomBytes(32)) — routing key + capability (0600)
//   ~/.eos/remote/bearer.secret  base64url(randomBytes(32)) — relay-join capability (0600)
//
// They survive a daemon restart so every reconnect uses the same room. Rotating
// (re-arm with rotate intent) overwrites them → existing phones must re-pair.
//
// Stale v2 artifacts (mac-static.key, devices/) are simply ignored — never
// deleted by hand (repo rule: ~/.eos is non-regenerable user data).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const SECRET_MODE = 0o600;

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Load a persisted secret, or mint + persist a fresh base64url(32-byte) one.
function loadOrMint(path: string): string {
  if (existsSync(path)) {
    const v = readFileSync(path, "utf8").trim();
    if (v) return v;
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret + "\n", { mode: SECRET_MODE });
  return secret;
}

// The room id + bearer for the armed relay leg. `room` rides the outer envelope's
// `room` field as ASCII (b64url is all-ASCII, safe); `bearer` is what the phone
// presents in the relay `join`, and the daemon's default relay allowlist is
// exactly `[ sha256Hex(bearer) ]` so a room is never world-joinable.
export class RoomSecrets {
  private readonly roomPath: string;
  private readonly bearerPath: string;
  readonly room: string;
  readonly bearer: string;

  constructor(remoteDir: string) {
    mkdirSync(remoteDir, { recursive: true });
    this.roomPath = join(remoteDir, "room.id");
    this.bearerPath = join(remoteDir, "bearer.secret");
    this.room = loadOrMint(this.roomPath);
    this.bearer = loadOrMint(this.bearerPath);
  }

  // The relay-admission allowlist: SHA-256(bearer). The relay stores only this
  // hash and admits a join iff SHA-256(presented bearer) is a member (§4.1).
  bearerHash(): string {
    return sha256Hex(this.bearer);
  }
}
