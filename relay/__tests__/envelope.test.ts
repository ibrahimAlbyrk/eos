import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  parseEnvelope,
  encodeEnvelope,
  encodeJsonEnvelope,
  FrameType,
  Dir,
  ZERO_CLIENT_ID,
} from "../envelope.ts";

test("round-trips a data envelope with opaque payload", () => {
  const clientId = randomBytes(16);
  const payload = randomBytes(64);
  const buf = encodeEnvelope({
    type: FrameType.data,
    dir: Dir.s2c,
    epoch: 0,
    seq: 42n,
    room: "AAAAAAAAAAAAAAAAAAAAAA",
    clientId,
    payload,
  });
  const env = parseEnvelope(buf);
  assert.equal(env.ver, 0x01);
  assert.equal(env.type, FrameType.data);
  assert.equal(env.dir, Dir.s2c);
  assert.equal(env.epoch, 0);
  assert.equal(env.seq, 42n);
  assert.equal(env.room, "AAAAAAAAAAAAAAAAAAAAAA");
  assert.ok(env.clientId.equals(clientId));
  assert.ok(env.payload.equals(payload));
});

test("preserves a full u64 seq without precision loss", () => {
  const buf = encodeEnvelope({
    type: FrameType.data,
    dir: Dir.c2s,
    seq: 18446744073709551615n, // 2^64 - 1
    room: "r",
    payload: Buffer.alloc(0),
  });
  assert.equal(parseEnvelope(buf).seq, 18446744073709551615n);
});

test("defaults clientId to all-zero (register / broadcast)", () => {
  const buf = encodeEnvelope({ type: FrameType.register, dir: Dir.c2s, room: "r", payload: Buffer.from("{}") });
  assert.ok(parseEnvelope(buf).clientId.equals(ZERO_CLIENT_ID));
});

test("json envelope carries a parseable control payload", () => {
  const buf = encodeJsonEnvelope({ type: FrameType.relayctl, room: "room22", json: { t: "joined", n: 1 } });
  const env = parseEnvelope(buf);
  assert.equal(env.type, FrameType.relayctl);
  assert.deepEqual(JSON.parse(env.payload.toString("utf8")), { t: "joined", n: 1 });
});

test("rejects a buffer shorter than the fixed header", () => {
  assert.throws(() => parseEnvelope(Buffer.alloc(5)), /fixed header/);
});

test("rejects a truncated header (declared room longer than buffer)", () => {
  const buf = encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, room: "ABCDEFGH", payload: Buffer.alloc(0) });
  assert.throws(() => parseEnvelope(buf.subarray(0, 15)), /declared header/);
});
