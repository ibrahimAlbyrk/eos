// Plaintext inner-frame framer (relay v3, §5). Replaces the per-session AEAD
// codec (session.ts, deleted): with encryption removed, a `data` envelope's
// payload is just UTF-8 JSON — one inner frame. This module is the trivial
// JSON ↔ `data` envelope translation, with no keys, no epoch/seq security, no
// replay/gap checks. epoch/seq are set to 0 in the outer header (kept for wire
// compat, unvalidated, §4.4).
//
//   encodeServerFrame() = Mac→device (s2c): inner frame JSON → data envelope bytes.
//   decodeClientFrame() = device→Mac (c2s): data envelope → validated ClientFrame.
//
// Transport (relay) is elsewhere; this is pure bytes in / bytes out.

import { Dir, FrameType, encodeEnvelope, type Envelope } from "./envelope.ts";
import { ClientFrameSchema, type ClientFrame } from "../../contracts/src/remote.ts";

// Seal one server→client inner frame into its on-wire outer envelope (plaintext).
export function encodeServerFrame(args: { room: string; clientId: Buffer; frame: object }): Buffer {
  return encodeEnvelope({
    type: FrameType.data, dir: Dir.s2c, epoch: 0, seq: 0n,
    room: args.room, clientId: args.clientId,
    payload: Buffer.from(JSON.stringify(args.frame), "utf8"),
  });
}

// Parse one client→server data envelope's plaintext payload into a validated
// inner frame. Returns null on non-JSON bytes or a shape the schema rejects.
export function decodeClientFrame(env: Envelope): ClientFrame | null {
  let parsed: unknown;
  try { parsed = JSON.parse(env.payload.toString("utf8")); } catch { return null; }
  const result = ClientFrameSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
