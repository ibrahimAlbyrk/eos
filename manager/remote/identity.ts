// Stable device identity + Noise msg-1 payload format (connection v2).
//
// relayDeviceId = b64u(BLAKE2b-256(deviceStaticPub)) — derived from the static
// key, so it never rotates and can never disagree with the key (§4.1). It is the
// relay-admission id AND the filename the Mac files the device under.
//
// msg-1 payload is a tiny, language-agnostic text format (NOT JSON) so the
// initiator's exact bytes are trivially reproducible byte-for-byte in Swift and
// Node — the Noise transcript binds these exact bytes, so only one canonical
// encoding may exist:
//   steady : "S"
//   enroll : "E" ‖ <enrollTokenB64u> ‖ "\n" ‖ <label-utf8>   (label is the tail)

import { hash } from "./crypto.ts";

export function relayDeviceId(deviceStaticPub: Buffer): string {
  return hash(deviceStaticPub).toString("base64url");
}

export const STEADY_PAYLOAD = Buffer.from("S", "ascii");

export function buildEnrollPayload(enrollTokenB64u: string, label: string): Buffer {
  return Buffer.from(`E${enrollTokenB64u}\n${label}`, "utf8");
}

export type Payload1 =
  | { kind: "steady" }
  | { kind: "enroll"; token: string; label: string };

export function parsePayload1(buf: Buffer): Payload1 | null {
  const s = buf.toString("utf8");
  if (s === "S") return { kind: "steady" };
  if (s.startsWith("E")) {
    const rest = s.slice(1);
    const nl = rest.indexOf("\n");
    if (nl < 0) return null;
    return { kind: "enroll", token: rest.slice(0, nl), label: rest.slice(nl + 1) };
  }
  return null;
}
