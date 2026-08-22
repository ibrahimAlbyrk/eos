import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeFrameHeader, canvasToPage, paintFrame, makeFramePump, FRAME_HEADER_BYTES } from "./paintFrame.js";

// Mirror of the daemon encoder (manager/browser-ws.ts encodeFrameHeader) so the
// wire contract is asserted from the client side too: 16-byte LE header.
function encodeHeader({ tabKey, seq, width, height }) {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES);
  const dv = new DataView(buf);
  dv.setUint32(0, tabKey, true);
  dv.setUint32(4, seq, true);
  dv.setUint16(8, width, true);
  dv.setUint16(10, height, true);
  return buf;
}

describe("decodeFrameHeader", () => {
  it("round-trips the daemon header layout", () => {
    const h = { tabKey: 0xdeadbeef, seq: 987654, width: 1024, height: 640 };
    expect(decodeFrameHeader(encodeHeader(h))).toEqual(h);
  });

  it("reads little-endian", () => {
    const buf = new Uint8Array(FRAME_HEADER_BYTES);
    buf[0] = 0x04; buf[1] = 0x03; buf[2] = 0x02; buf[3] = 0x01; // tabKey
    buf[8] = 0x00; buf[9] = 0x04; // width 1024
    expect(decodeFrameHeader(buf.buffer)).toMatchObject({ tabKey: 0x01020304, width: 1024 });
  });
});

// A minimal canvas double: enough surface for paintFrame (width/height props +
// a 2d context with drawImage).
function fakeCanvas() {
  const draws = [];
  return {
    width: 0,
    height: 0,
    draws,
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
  };
}

describe("paintFrame sizes the canvas to the ACTUAL frame bitmap", () => {
  afterEach(() => vi.unstubAllGlobals());

  const frame = (h) => {
    const buf = new ArrayBuffer(FRAME_HEADER_BYTES + 4);
    new DataView(buf).setUint32(4, h.seq ?? 1, true);
    return buf;
  };

  it("resizes the backing store to the decoded bitmap dims, not the header or the box", async () => {
    // The bitmap is the truth: device switches deliver transitional sizes
    // (harness 13-dims measured a 296x640 frame whose metadata claimed 375x812).
    vi.stubGlobal("createImageBitmap", async () => ({ width: 296, height: 640, close: () => {} }));
    const canvas = fakeCanvas();
    await paintFrame(canvas, frame({ seq: 7 }));
    expect(canvas.width).toBe(296);
    expect(canvas.height).toBe(640);
    expect(canvas.draws.length).toBe(1);
  });

  it("keeps the backing store when dims are unchanged (resizing clears a canvas)", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1024, height: 640, close: () => {} }));
    const canvas = fakeCanvas();
    await paintFrame(canvas, frame({ seq: 1 }));
    // poison the setters: a second same-size paint must not touch them
    let resized = false;
    Object.defineProperty(canvas, "width", { get: () => 1024, set: () => { resized = true; } });
    Object.defineProperty(canvas, "height", { get: () => 640, set: () => { resized = true; } });
    await paintFrame(canvas, frame({ seq: 2 }));
    expect(resized).toBe(false);
  });
});

describe("makeFramePump — the ack contract (a skipped ack wedges the stream)", () => {
  const frame = (seq) => {
    const buf = new ArrayBuffer(FRAME_HEADER_BYTES + 4);
    new DataView(buf).setUint32(4, seq, true);
    return buf;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("acks a frame whose paint THROWS — the daemon stops after 3 unacked, so paint failure must still ack", async () => {
    const acks = [];
    const pump = makeFramePump({
      getCanvas: () => null,
      send: (msg) => acks.push(msg),
      paint: async () => { throw new Error("decode failed"); },
    });
    pump.push(frame(41));
    await flush();
    pump.push(frame(42));
    await flush();
    pump.push(frame(43));
    await flush();
    expect(acks).toEqual([
      { type: "ack", seq: 41 },
      { type: "ack", seq: 42 },
      { type: "ack", seq: 43 },
    ]);
  });

  it("acks the newest frame when an older queued one is superseded (max-seq covers the skip)", async () => {
    const acks = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const pump = makeFramePump({
      getCanvas: () => null,
      send: (msg) => acks.push(msg),
      paint: async () => { await gate; },
    });
    pump.push(frame(1)); // starts painting, held by the gate
    pump.push(frame(2)); // queued…
    pump.push(frame(3)); // …superseded by 3 (latest wins)
    release();
    await flush();
    await flush();
    expect(acks.map((a) => a.seq)).toEqual([1, 3]); // 2 skipped; ack(3) > 2 reopens its slot
  });

  it("stops acking after dispose", async () => {
    const acks = [];
    const pump = makeFramePump({ getCanvas: () => null, send: (m) => acks.push(m), paint: async () => {} });
    pump.dispose();
    pump.push(frame(9));
    await flush();
    expect(acks).toEqual([]);
  });
});

describe("canvasToPage", () => {
  const viewport = { width: 1280, height: 800 };

  it("scales canvas CSS offsets to viewport CSS px", () => {
    // canvas displayed at half the viewport's CSS size
    expect(canvasToPage(320, 200, 640, 400, viewport)).toEqual({ x: 640, y: 400 });
  });

  it("is identity when the canvas CSS box matches the viewport", () => {
    expect(canvasToPage(17, 33, 1280, 800, viewport)).toEqual({ x: 17, y: 33 });
  });

  it("rounds and clamps inside the viewport", () => {
    expect(canvasToPage(639.6, 0.4, 1280, 800, viewport)).toEqual({ x: 640, y: 0 });
    expect(canvasToPage(5000, -10, 1280, 800, viewport)).toEqual({ x: 1280, y: 0 });
  });

  it("holds at a Responsive non-default viewport (daemon emulates the panel box, so viewport == canvas CSS size)", () => {
    // Responsive now sizes the viewport to the panel, so the mapping is identity
    // at any panel size/aspect — not just the old fixed 1280×800.
    const wide = { width: 1600, height: 900 };
    expect(canvasToPage(800, 450, 1600, 900, wide)).toEqual({ x: 800, y: 450 });
    const tall = { width: 900, height: 1200 };
    expect(canvasToPage(123, 456, 900, 1200, tall)).toEqual({ x: 123, y: 456 });
    // And still proportional if the canvas is displayed at a fraction of it.
    expect(canvasToPage(400, 225, 800, 450, wide)).toEqual({ x: 800, y: 450 });
  });
});
