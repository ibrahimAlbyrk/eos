// Edge refraction for liquid glass (Chromium only): a displacement map for a
// rounded rect, fed to an SVG <feDisplacementMap> that the glass backdrop uses as
// `backdrop-filter: url(#lens) blur(..)`. WebKit ignores url() there and falls
// back to the plain blur.
//
// Each pixel inside the `bevel` band along the edge pushes the backdrop outward
// along the edge normal (strongest at the rim, smoothstep to zero inward); the
// flat middle stays neutral (128). R = x offset, G = y offset.
export function lensDisplacement(w, h, radius, bevel) {
  const data = new Uint8ClampedArray(w * h * 4);
  const hw = w / 2, hh = h / 2;
  const r = Math.min(radius, hw, hh);
  // signed distance to the rounded rect's edge (negative inside)
  const sdf = (x, y) => {
    const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw, py = y + 0.5 - hh;
      const dist = -sdf(px, py);
      let dx = 0, dy = 0;
      if (dist > 0 && dist < bevel) {
        const gx = sdf(px + 1, py) - sdf(px - 1, py);
        const gy = sdf(px, py + 1) - sdf(px, py - 1);
        const len = Math.hypot(gx, gy) || 1;
        const t = 1 - dist / bevel;
        const k = t * t * (3 - 2 * t);
        dx = -gx / len * k;
        dy = -gy / len * k;
      }
      const i = (y * w + x) * 4;
      data[i] = 128 + dx * 127;
      data[i + 1] = 128 + dy * 127;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return data;
}

export function lensMap(w, h, radius, bevel) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(lensDisplacement(w, h, radius, bevel), w, h), 0, 0);
  return canvas.toDataURL();
}
