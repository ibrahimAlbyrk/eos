import { describe, it, expect } from "vitest";
import { decodeFrameHeader, canvasToPage, FRAME_HEADER_BYTES } from "./paintFrame.js";

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
