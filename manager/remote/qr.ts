// Pairing QR generation (protocol §6). The Mac app renders this payload as a
// QR; the phone scans it and gains the pre-authenticated material to run a cold
// PAIRING handshake: the pinned Mac identity, a single-use short-lived one-time
// secret (ots) + pairing bearer, the LAN/relay addresses, and the LAN cert pin.
//
// The caller holds the returned `ots`/`bearer` secrets server-side: `ots` seeds
// the HandshakeServer pairing context (burned on PAIR-3), `bearer` is added to
// the relay allowlist for the pairing window then dropped after enrollment.

import { randomBytes } from "node:crypto";
import { PairingQrSchema, type PairingQr } from "../../contracts/src/remote.ts";
import type { MacIdentity } from "./keyring.ts";

const OTS_TTL_MS = 120_000; // §6: e.g. now+120s

export interface PairingOffer {
  qr: PairingQr;
  ots: Buffer; // 32B one-time secret — keep for the handshake; single-use
  bearer: Buffer; // 32B one-time pairing bearer — add SHA-256 to the relay allowlist
}

export function generatePairing(args: {
  identity: MacIdentity;
  now: number;
  lan?: string[]; // e.g. ["wss://192.168.1.42:7400/ws"]
  lanSpki?: string | null; // b64 SHA-256 of the LAN self-signed cert SPKI
  relay?: { url: string; room: string } | null;
  ttlMs?: number;
}): PairingOffer {
  const ots = randomBytes(32);
  const bearer = randomBytes(32);
  const exp = args.now + (args.ttlMs ?? OTS_TTL_MS);
  const qr: PairingQr = {
    v: 1,
    typ: "eos-pair",
    macPub: args.identity.publicSec1().toString("base64url"),
    ots: ots.toString("base64url"),
    otsExp: Math.floor(exp / 1000),
    lan: args.lan ?? [],
    lanSpki: args.lanSpki ?? null,
    relay: args.relay ?? null,
    bearer: bearer.toString("base64url"),
    exp: Math.floor(exp / 1000),
  };
  // Fail loud if the payload ever drifts from the contract.
  PairingQrSchema.parse(qr);
  return { qr, ots, bearer };
}
