import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fnv1a,
  encodeFrameHeader,
  decodeFrameHeader,
  shouldDropFrame,
  displayFrom,
  FRAME_HEADER_BYTES,
  MAX_UNACKED_FRAMES,
  BACKPRESSURE_BYTES,
} from "../browser-ws.ts";
import { DISPLAY_DEFAULTS } from "../services/BrowserService.ts";

test("frame header encode/decode round-trip", () => {
  const h = { tabKey: fnv1a("bt-abc123"), seq: 4242, width: 1024, height: 640 };
  const buf = encodeFrameHeader(h);
  assert.equal(buf.length, FRAME_HEADER_BYTES);
  assert.deepEqual(decodeFrameHeader(buf), h);
  // reserved u32 stays zero
  assert.equal(buf.readUInt32LE(12), 0);
});

test("frame header is little-endian at fixed offsets", () => {
  const buf = encodeFrameHeader({ tabKey: 0x01020304, seq: 1, width: 2, height: 3 });
  assert.deepEqual([...buf.subarray(0, 4)], [0x04, 0x03, 0x02, 0x01]);
  assert.deepEqual([...buf.subarray(8, 10)], [2, 0]);
  assert.deepEqual([...buf.subarray(10, 12)], [3, 0]);
});

test("fnv1a is stable and 32-bit", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("bt-x"), fnv1a("bt-x"));
  assert.notEqual(fnv1a("bt-x"), fnv1a("bt-y"));
  for (const s of ["a", "bt-abc", "\u{1F600}"]) {
    const v = fnv1a(s);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  }
});

test("backpressure drop rule: unacked window", () => {
  // under the window → send
  assert.equal(shouldDropFrame({ bufferedAmount: 0, sentSeq: 2, ackedSeq: 0 }), false);
  // at MAX_UNACKED_FRAMES behind → drop, never queue
  assert.equal(shouldDropFrame({ bufferedAmount: 0, sentSeq: MAX_UNACKED_FRAMES, ackedSeq: 0 }), true);
  // acks reopen the window
  assert.equal(shouldDropFrame({ bufferedAmount: 0, sentSeq: 10, ackedSeq: 8 }), false);
});

test("backpressure drop rule: socket buffer bytes", () => {
  assert.equal(shouldDropFrame({ bufferedAmount: BACKPRESSURE_BYTES, sentSeq: 0, ackedSeq: 0 }), false);
  assert.equal(shouldDropFrame({ bufferedAmount: BACKPRESSURE_BYTES + 1, sentSeq: 0, ackedSeq: 0 }), true);
});

test("displayFrom: carries the panel's live size, falls back on missing/junk (never a 0-sized stream)", () => {
  assert.deepEqual(displayFrom({ cssWidth: 800, cssHeight: 600, dpr: 2 }), { cssWidth: 800, cssHeight: 600, dpr: 2 });
  assert.deepEqual(displayFrom({ cssWidth: 0, cssHeight: 600, dpr: 2 }), DISPLAY_DEFAULTS);
  assert.deepEqual(displayFrom({ cssWidth: 800, cssHeight: 600 }), DISPLAY_DEFAULTS); // no dpr
  assert.deepEqual(displayFrom({}), DISPLAY_DEFAULTS);
});
