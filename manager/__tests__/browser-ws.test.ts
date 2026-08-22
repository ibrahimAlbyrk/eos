import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fnv1a,
  encodeFrameHeader,
  decodeFrameHeader,
  shouldDropFrame,
  healWedgedWindow,
  displayFrom,
  FRAME_HEADER_BYTES,
  MAX_UNACKED_FRAMES,
  BACKPRESSURE_BYTES,
  ACK_WINDOW_RESET_MS,
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

// The white-screen wedge (harness 14-wedge-e2e): MAX_UNACKED_FRAMES missed acks
// and the drop rule blocks every later frame forever — no frame ever reaches
// the client to carry a newer ack, so the stall is permanent without this heal.
test("healWedgedWindow reopens a window that stalled full, never a live one", () => {
  const t0 = 1_000_000;
  // Window full, no progress long enough → abandon the missing acks.
  const wedged = { sentSeq: 10, ackedSeq: 10 - MAX_UNACKED_FRAMES, lastProgressAt: t0 };
  assert.equal(healWedgedWindow(wedged, t0 + ACK_WINDOW_RESET_MS - 1), false, "not before the reset deadline");
  assert.equal(wedged.ackedSeq, 10 - MAX_UNACKED_FRAMES);
  assert.equal(healWedgedWindow(wedged, t0 + ACK_WINDOW_RESET_MS), true, "heals at the deadline");
  assert.equal(wedged.ackedSeq, 10, "window reopened: the next frame sends");
  assert.equal(shouldDropFrame({ bufferedAmount: 0, sentSeq: wedged.sentSeq, ackedSeq: wedged.ackedSeq }), false);
  // A window that is not full never heals, no matter how old — normal acking
  // clients are untouched.
  const live = { sentSeq: 10, ackedSeq: 8, lastProgressAt: 0 };
  assert.equal(healWedgedWindow(live, Number.MAX_SAFE_INTEGER), false);
  assert.equal(live.ackedSeq, 8);
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
