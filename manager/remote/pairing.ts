// Active pairing-offer holder. The Mac app arms an offer (shows the QR); a
// connecting device with that one-time bearer runs cold PAIRING against the
// held ots. Single offer at a time; burned on a successful pair or re-arm.
// Implements the gateway's PairingProvider.

import { createHash } from "node:crypto";
import { generatePairing } from "./qr.ts";
import type { MacIdentity } from "./keyring.ts";
import type { PairingProvider } from "./gateway.ts";
import type { PairingQr } from "../../contracts/src/remote.ts";

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export class PairingManager implements PairingProvider {
  private readonly identity: MacIdentity;
  private readonly nowFn: () => number;
  private offer: { ots: Buffer; bearerHashHex: string; qr: PairingQr } | null = null;

  constructor(identity: MacIdentity, now: () => number) {
    this.identity = identity;
    this.nowFn = now;
  }

  // Arm a fresh offer and return the QR payload to render. Any prior offer is
  // discarded (single-use, one at a time).
  arm(opts: { lan?: string[]; lanSpki?: string | null; relay?: { url: string; room: string } | null; ttlMs?: number }): PairingQr {
    const offer = generatePairing({ identity: this.identity, now: this.nowFn(), ...opts });
    this.offer = { ots: offer.ots, bearerHashHex: sha256Hex(offer.qr.bearer as string), qr: offer.qr };
    return offer.qr;
  }

  pairingBearerHash(): string | null { return this.offer?.bearerHashHex ?? null; }
  ots(): Buffer | null { return this.offer?.ots ?? null; }
  burn(): void { this.offer = null; }
}
