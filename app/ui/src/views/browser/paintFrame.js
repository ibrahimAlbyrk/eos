// paintFrame — the frame-WS client leg shared by BrowserCanvas.jsx and the
// Phase 2 measurement harness (the harness page loads this exact file, so its
// fps/latency numbers ARE the real panel paint path). Framework-free on
// purpose: header decode + paint + coordinate translation only.

export const FRAME_HEADER_BYTES = 16;

// 16-byte little-endian header (plan §3.3): u32 tabKey · u32 seq · u16 width ·
// u16 height · u32 reserved. width/height = the JPEG bitmap's device px.
export function decodeFrameHeader(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  return {
    tabKey: dv.getUint32(0, true),
    seq: dv.getUint32(4, true),
    width: dv.getUint16(8, true),
    height: dv.getUint16(10, true),
  };
}

// Paint one binary WS frame: createImageBitmap → drawImage → close — never
// blob URLs or data URIs (they leak; plan §3.3). The canvas backing store is
// resized only when the frame size changes (resizing clears the canvas).
export async function paintFrame(canvas, arrayBuffer) {
  const header = decodeFrameHeader(arrayBuffer);
  const jpeg = new Blob([new Uint8Array(arrayBuffer, FRAME_HEADER_BYTES)], { type: "image/jpeg" });
  const bmp = await createImageBitmap(jpeg);
  if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas.width = bmp.width;
    canvas.height = bmp.height;
  }
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return { ...header, bytes: arrayBuffer.byteLength - FRAME_HEADER_BYTES };
}

// Canvas→page translation (plan §3.4): the canvas CSS box shows the whole
// viewport, so page coords are just the offset scaled by viewport/canvas CSS
// size. Returns viewport CSS px, rounded, clamped inside the viewport.
export function canvasToPage(offsetX, offsetY, canvasCssWidth, canvasCssHeight, viewport) {
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  return {
    x: clamp(Math.round((offsetX * viewport.width) / canvasCssWidth), viewport.width),
    y: clamp(Math.round((offsetY * viewport.height) / canvasCssHeight), viewport.height),
  };
}
