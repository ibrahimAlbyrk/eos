// Pairing QR generation (connection v2 §5.2). The Mac app renders this payload
// as a QR; the phone scans it once to enroll. It carries the pinned Mac static
// X25519 key, a one-time enrollment token (also the relay-admission value for the
// pairing window), and the transport coordinates.
//
// The caller holds the returned `enrollToken` server-side: its SHA-256 is added
// to the relay allowlist for the pairing window, and the token is matched (then
// burned) when the device presents it inside Noise msg-1 (§5.2).

import { randomBytes } from "node:crypto";
import { PairingQrSchema, type PairingQr } from "../../contracts/src/remote.ts";
import type { MacIdentity } from "./keyring.ts";

const ENROLL_TTL_MS = 120_000; // §5.2: short window, e.g. now+120s

export interface PairingOffer {
  qr: PairingQr;
  enrollToken: Buffer; // 32B one-time enrollment token — single-use
}

export function generatePairing(args: {
  identity: MacIdentity;
  now: number;
  lan?: string[];
  lanSpki?: string | null;
  relay?: { url: string; room: string } | null;
  ttlMs?: number;
}): PairingOffer {
  const enrollToken = randomBytes(32);
  const exp = args.now + (args.ttlMs ?? ENROLL_TTL_MS);
  const qr: PairingQr = {
    v: 2,
    typ: "eos-pair",
    macStatic: args.identity.publicKey().toString("base64url"),
    enroll: enrollToken.toString("base64url"),
    lan: args.lan ?? [],
    lanSpki: args.lanSpki ?? null,
    relay: args.relay ?? null,
    exp: Math.floor(exp / 1000),
  };
  PairingQrSchema.parse(qr); // fail loud if the payload drifts from the contract
  return { qr, enrollToken };
}
