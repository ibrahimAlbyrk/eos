// Eos ↔ Eos peering — identity + trust rules, pure (no node:*).
//
// A device's identity is its self-signed TLS certificate; the certificate's
// SHA-256 fingerprint (64 lowercase hex) is what both sides pin. People compare
// the short Device ID derived from it (first 80 bits, Crockford base32, grouped).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function isFingerprint(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export function base32Crockford(bytes: readonly number[]): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

// "7K3F-9QXM-2D8A-LP4C": 16 chars = 80 bits of the fingerprint, enough for a
// human to spot a swapped key; the full fingerprint is what software pins.
export function formatDeviceId(fingerprintHex: string): string {
  const chars = base32Crockford(hexToBytes(fingerprintHex.slice(0, 20)));
  return chars.match(/.{1,4}/g)?.join("-") ?? chars;
}

export function shortDeviceId(fingerprintHex: string): string {
  return formatDeviceId(fingerprintHex).slice(0, 9);
}

// An invite is single-use and, from this build on, never expires on its own;
// links from older builds may still carry `exp` (unix seconds).
export type InviteState = "valid" | "expired";

export function inviteState(invite: { exp?: number }, nowMs: number): InviteState {
  return invite.exp != null && nowMs >= invite.exp * 1000 ? "expired" : "valid";
}

// What a connecting peer is allowed to do, decided from its pinned fingerprint:
// a paired device gets the full ui plane; an unknown one may only redeem an
// invite (and only while pairing is open); anything else is refused.
export type PeerAdmission = "trusted" | "pairing-only" | "refused";

export function admitPeer(args: {
  fingerprint: string;
  trusted: ReadonlySet<string>;
  pairingOpen: boolean;
}): PeerAdmission {
  if (args.trusted.has(args.fingerprint)) return "trusted";
  return args.pairingOpen ? "pairing-only" : "refused";
}
