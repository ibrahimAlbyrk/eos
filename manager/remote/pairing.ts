// Active enrollment-offer holder (connection v2 §5.2). The Mac app arms an offer
// (shows the QR); a not-yet-enrolled device joins the room with the enrollment
// token and presents it inside Noise msg-1. Single offer at a time; burned on a
// successful enrollment or on re-arm. Implements the gateway's PairingProvider.

import { createHash, timingSafeEqual } from "node:crypto";
import { generatePairing } from "./qr.ts";
import type { MacIdentity } from "./keyring.ts";
import type { PairingProvider } from "./gateway.ts";
import type { PairingQr } from "../../contracts/src/remote.ts";

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function constantTimeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class PairingManager implements PairingProvider {
  private readonly identity: MacIdentity;
  private readonly nowFn: () => number;
  private offer: { tokenB64u: string; tokenHashHex: string; qr: PairingQr } | null = null;

  constructor(identity: MacIdentity, now: () => number) {
    this.identity = identity;
    this.nowFn = now;
  }

  // Arm a fresh offer and return the QR. Any prior offer is discarded.
  arm(opts: { lan?: string[]; lanSpki?: string | null; relay?: { url: string; room: string } | null; ttlMs?: number }): PairingQr {
    const offer = generatePairing({ identity: this.identity, now: this.nowFn(), ...opts });
    const tokenB64u = offer.qr.enroll;
    this.offer = { tokenB64u, tokenHashHex: sha256Hex(tokenB64u), qr: offer.qr };
    return offer.qr;
  }

  // The SHA-256 of the armed token (hex) for the relay allowlist, or null.
  enrollTokenHash(): string | null { return this.offer?.tokenHashHex ?? null; }

  // Verify a token a device presented inside Noise msg-1. Constant-time; does NOT
  // burn (the caller burns only after a fully successful handshake + enroll).
  matchToken(tokenB64u: string): boolean {
    if (!this.offer) return false;
    return constantTimeEqualStr(tokenB64u, this.offer.tokenB64u);
  }

  burn(): void { this.offer = null; }
}
