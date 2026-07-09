// Pairing QR generation (plaintext relay v3, §2.3). The Mac app renders this
// payload as a QR; the phone scans it once to obtain the whole credential —
// (relay, room, bearer). There is no pinned static key and no enrollment token:
// the relay `join` bearer IS the join credential (§1.2). The room + bearer are
// already-minted runtime secrets (RoomSecrets); this only shapes them into the
// v3 QR and stamps the display-window close.

import { PairingQrSchema, type PairingQr } from "../../contracts/src/remote.ts";

const QR_TTL_MS = 120_000; // §2.1: short display window, e.g. now+120s

export function generatePairing(args: {
  now: number;
  relayUrl: string;
  room: string;
  bearer: string | null;
  ttlMs?: number;
}): PairingQr {
  const exp = args.now + (args.ttlMs ?? QR_TTL_MS);
  const qr: PairingQr = {
    v: 3,
    typ: "eos-pair",
    relay: args.relayUrl,
    room: args.room,
    bearer: args.bearer ?? undefined,
    exp: Math.floor(exp / 1000),
  };
  PairingQrSchema.parse(qr); // fail loud if the payload drifts from the contract
  return qr;
}
