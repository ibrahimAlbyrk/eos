import { createHash, timingSafeEqual } from "node:crypto";

// Hash-allowlist admission — protocol §5.1. The relay stores ONLY SHA-256(bearer)
// and never holds a usable bearer at rest. Admission is a constant-time compare of
// SHA-256(presented bearer) against the room's stored hashes.

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function ownerHashMatches(presentedOwner: string, storedHash: string): boolean {
  return constantTimeHexEqual(sha256Hex(presentedOwner), storedHash);
}

// Membership without early-out so timing does not reveal which (or whether an early)
// entry matched. Always scans the whole set.
export function bearerAllowed(presentedBearer: string, allow: Set<string>): boolean {
  const presentedHash = sha256Hex(presentedBearer);
  let matched = false;
  for (const stored of allow) {
    if (constantTimeHexEqual(presentedHash, stored)) matched = true;
  }
  return matched;
}
