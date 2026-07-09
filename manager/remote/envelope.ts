// Outer envelope codec — §4.4. The ONLY structure the relay parses. Byte-for-byte
// identical to relay/envelope.ts (confirmed with relay-impl): a 13-byte fixed
// big-endian header, then room + clientId(16) + payload. For type=0x01 data the
// payload is now plaintext inner-frame JSON (§5) the relay forwards verbatim;
// relay-control types carry UTF-8 JSON the relay does parse. `epoch`/`seq` are
// kept in the header for wire-compat but lost their crypto role — set to 0 and
// not validated (§4.4).
//
// This file duplicates the relay's tiny codec intentionally — the byte layout
// is the cross-impl contract, not shared code (the relay is a separate package).

export const ENVELOPE_VER = 0x01;

export const FrameType = {
  data: 0x01,
  register: 0x02,
  join: 0x03,
  relayctl: 0x04,
  ka: 0x05,
  error: 0x06,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const Dir = { c2s: 0x00, s2c: 0x01 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

export const CLIENT_ID_LEN = 16;
export const ZERO_CLIENT_ID = Buffer.alloc(CLIENT_ID_LEN);
export const MAX_ENVELOPE_BYTES = 5 * 1024 * 1024; // §4.1

const FIXED_HEADER = 13; // ver(1) type(1) dir(1) epoch(1) seq(8) roomLen(1)

export interface Envelope {
  ver: number;
  type: FrameType;
  dir: Dir;
  epoch: number;
  seq: bigint;
  room: string;
  clientId: Buffer;
  payload: Buffer;
}

export function parseEnvelope(buf: Buffer): Envelope {
  if (buf.length < FIXED_HEADER) throw new Error("envelope shorter than fixed header");
  const ver = buf.readUInt8(0);
  const type = buf.readUInt8(1) as FrameType;
  const dir = buf.readUInt8(2) as Dir;
  const epoch = buf.readUInt8(3);
  const seq = buf.readBigUInt64BE(4);
  const roomLen = buf.readUInt8(12);
  const headerLen = FIXED_HEADER + roomLen + CLIENT_ID_LEN;
  if (buf.length < headerLen) throw new Error("envelope shorter than declared header");
  const room = buf.toString("ascii", FIXED_HEADER, FIXED_HEADER + roomLen);
  const clientId = buf.subarray(FIXED_HEADER + roomLen, headerLen);
  const payload = buf.subarray(headerLen);
  return { ver, type, dir, epoch, seq, room, clientId, payload };
}

export function encodeEnvelope(e: {
  type: FrameType;
  dir: Dir;
  epoch?: number;
  seq?: bigint;
  room: string;
  clientId?: Buffer;
  payload: Buffer;
}): Buffer {
  const roomBytes = Buffer.from(e.room, "ascii");
  if (roomBytes.length > 0xff) throw new Error("room id exceeds 255 bytes");
  const clientId = e.clientId ?? ZERO_CLIENT_ID;
  if (clientId.length !== CLIENT_ID_LEN) throw new Error("clientId must be 16 bytes");
  const header = Buffer.alloc(FIXED_HEADER + roomBytes.length + CLIENT_ID_LEN);
  header.writeUInt8(ENVELOPE_VER, 0);
  header.writeUInt8(e.type, 1);
  header.writeUInt8(e.dir, 2);
  header.writeUInt8(e.epoch ?? 0, 3);
  header.writeBigUInt64BE(e.seq ?? 0n, 4);
  header.writeUInt8(roomBytes.length, 12);
  roomBytes.copy(header, FIXED_HEADER);
  clientId.copy(header, FIXED_HEADER + roomBytes.length);
  return Buffer.concat([header, e.payload]);
}

export function encodeJsonEnvelope(e: {
  type: FrameType;
  room: string;
  dir?: Dir;
  clientId?: Buffer;
  json: unknown;
}): Buffer {
  return encodeEnvelope({
    type: e.type,
    dir: e.dir ?? Dir.s2c,
    room: e.room,
    clientId: e.clientId,
    payload: Buffer.from(JSON.stringify(e.json), "utf8"),
  });
}
