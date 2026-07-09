// Outer envelope codec — protocol §4.4. This is the ONLY structure the relay
// understands. For `data` frames the payload is opaque application bytes the relay
// forwards verbatim and never parses (plaintext inner-frame JSON since protocol
// v3; the relay is blind to its contents either way); the relay-control types
// carry a JSON payload the relay does parse.

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
export const MAX_ENVELOPE_BYTES = 5 * 1024 * 1024; // §4.1 max envelope size

// Fixed header: ver(1) type(1) dir(1) epoch(1) seq(8) roomLen(1) = 13 bytes,
// then room(roomLen) + clientId(16) + payload.
const FIXED_HEADER = 13;

export type Envelope = {
  ver: number;
  type: FrameType;
  dir: Dir;
  epoch: number;
  seq: bigint;
  room: string;
  clientId: Buffer; // 16 bytes
  payload: Buffer;
};

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

// Relay-control payloads (register/join/relayctl/error) are UTF-8 JSON.
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
