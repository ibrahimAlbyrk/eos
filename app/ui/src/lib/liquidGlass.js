// "Regular Glass" from ybouane/liquidglass — its fragment shader (src/shaders.ts
// FS_GLASS) with the demo panel's config (defaults.ts + blurAmount 0), ported to
// maps for a backdrop-filter (Chromium only). The reference rasterises the page
// into WebGL; here Chromium hands the filter the live backdrop, so everything in
// the shader that depends only on the panel's shape is computed once per size:
//   disp    per colour channel, where to sample the backdrop (refraction ± the
//           chromatic aberration) — R = x, G = y, for <feDisplacementMap>
//   shade   the lighting as fin = col · gain + light: fresnel, rim, inner
//           glow, inner stroke. Grey = gain / GAIN_MAX, alpha = 1 − light —
//           grey and alpha survive colour management, so gain never bleeds
//           into light
//   shadow  the drop shadow around the panel (alpha only)
// Blur, specular, distortion, tint, saturation and brightness are 0 in this
// preset, so their terms drop out. Lengths are device px, as in the reference.
export const REGULAR_GLASS = {
  refraction: 0.69,
  chromAberration: 0.05,
  edgeHighlight: 0.05,
  fresnel: 1,
  zRadius: 40,
  shadowOpacity: 0.3,
  shadowSpread: 10,
  shadowOffsetY: 1,
};

// CSS px the shadow reaches past the panel
export const SHADOW_PAD = 20;
// the brightest the glass lifts what is behind it (flat middle: 1 + 0.06)
export const GAIN_MAX = 1.06;

const smoothstep = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

// signed distance to a rounded rect centred on 0 (negative inside)
const rrSDF = (x, y, bx, by, r) => {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};

// half-circle bevel profile: steep at the rim, flat from zR inward
const bevelHeight = (d, zR) => (d <= 0 ? 0 : d >= zR ? zR : Math.sqrt(d * (2 * zR - d)));

// One pixel inside the panel, p from its centre (y down). Writes
// [refraction x, y, aberration x, y, gain, light] into out.
function glassPixel(out, px, py, hx, hy, r, zR, cfg) {
  const inside = -rrSDF(px, py, hx, hy, r);
  const edge = smoothstep(Math.min(hx, hy) * 0.35, 0, inside);
  const h = (x, y) => bevelHeight(-rrSDF(x, y, hx, hy, r), zR);
  const e = 2;
  const gx = (h(px + e, py) - h(px - e, py)) / (2 * e);
  const gy = (h(px, py + e) - h(px, py - e)) / (2 * e);
  const nLen = Math.hypot(gx, gy, 1);
  const nx = -gx / nLen, ny = -gy / nLen, nz = 1 / nLen;
  const depth = smoothstep(0, zR, inside);

  // biconvex refraction: entry + exit + the path through, plus a pull to the centre
  const thickNorm = (bevelHeight(inside, zR) * 2) / Math.max(zR * 2, 1);
  const bend = (1 - 1 / 1.5) * (2 + thickNorm * 0.5) * cfg.refraction * 30;
  const pull = cfg.refraction * 4 * depth;
  out[0] = gx * bend - (px / Math.max(hx, 1)) * pull;
  out[1] = gy * bend - (py / Math.max(hy, 1)) * pull;

  // red is sampled outward along the normal, blue inward
  const ca = cfg.chromAberration * 18 * (edge * 0.7 + 0.3) * 2;
  out[2] = nx * ca;
  out[3] = ny * ca;

  const fres = Math.pow(1 - Math.abs(nz), 4) * cfg.fresnel;
  const stroke = smoothstep(-2.5, -1.5, -inside) * (1 - smoothstep(-1, 0, -inside))
    * (0.4 + 0.6 * (0.5 - 0.5 * (py / hy)));
  const rim = edge * cfg.edgeHighlight * 0.22;
  const innerGlow = smoothstep(5, 0, inside) * cfg.edgeHighlight * 0.15;
  const env = (ny * 0.5 + 0.5) * fres * 0.08;
  const light = rim + innerGlow + stroke * cfg.edgeHighlight * 0.55 + env;
  const white = fres * 0.2;
  out[4] = (1 + 0.06 * depth) * (1 - white);
  out[5] = light * (1 - white) + white;
}

function shadowAlpha(px, py, hx, hy, r, dpr, cfg) {
  const d = Math.max(rrSDF(px, py - cfg.shadowOffsetY * dpr, hx, hy, r) - 1, 0);
  const spread = Math.max(cfg.shadowSpread * dpr, 1);
  const outer = Math.exp(-d * d / (spread * spread)) * 0.65;
  const contact = Math.exp(-d * 0.08 / Math.max(spread * 0.04, 0.01)) * 0.35;
  const s = (outer + contact) * cfg.shadowOpacity;
  // the reference blends alpha with SRC_ALPHA too, so s² is what shows
  return s * s;
}

// The maps for a w × h (CSS px) panel with the given corner radius. `scale` is
// the <feDisplacementMap> scale in CSS px.
export function regularGlass(w, h, dpr, radius, cfg = REGULAR_GLASS) {
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  const hx = W / 2, hy = H / 2;
  const r = Math.min(radius * dpr, hx, hy);
  const zR = cfg.zRadius * dpr;

  const px = new Float32Array(W * H * 6);
  const out = new Float64Array(6);
  let max = 1e-6;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 6;
      const X = x + 0.5 - hx, Y = y + 0.5 - hy;
      if (rrSDF(X, Y, hx, hy, r) > 0) { px[i + 4] = 1; continue; }
      glassPixel(out, X, Y, hx, hy, r, zR, cfg);
      px.set(out, i);
      max = Math.max(max, Math.abs(out[0]) + Math.abs(out[2]), Math.abs(out[1]) + Math.abs(out[3]));
    }
  }

  const scale = max * 2;
  const disp = [1, 0, -1].map((sign) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0, j = 0; j < data.length; i += 6, j += 4) {
      data[j] = 255 * ((px[i] + sign * px[i + 2]) / scale + 0.5);
      data[j + 1] = 255 * ((px[i + 1] + sign * px[i + 3]) / scale + 0.5);
      data[j + 2] = 128;
      data[j + 3] = 255;
    }
    return data;
  });
  const shade = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, j = 0; j < shade.length; i += 6, j += 4) {
    shade[j] = shade[j + 1] = shade[j + 2] = 255 * (px[i + 4] / GAIN_MAX);
    shade[j + 3] = 255 * (1 - px[i + 5]);
  }

  const pad = Math.round(SHADOW_PAD * dpr);
  const SW = W + pad * 2, SH = H + pad * 2;
  const shadow = new Uint8ClampedArray(SW * SH * 4);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const X = x + 0.5 - SW / 2, Y = y + 0.5 - SH / 2;
      if (rrSDF(X, Y, hx, hy, r) > 0) shadow[(y * SW + x) * 4 + 3] = 255 * shadowAlpha(X, Y, hx, hy, r, dpr, cfg);
    }
  }

  return {
    width: W, height: H, scale: scale / dpr,
    disp, shade,
    shadow: { width: SW, height: SH, data: shadow },
  };
}
