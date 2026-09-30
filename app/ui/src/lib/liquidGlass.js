// ybouane/liquidglass — its fragment shader (src/shaders.ts FS_GLASS) ported to
// maps for a backdrop-filter (Chromium only), with the demo's panel configs as
// presets: Frosted Glass is the composer card's; Clear and Dark Glass (and
// Dark's grades) are kept for other surfaces. The reference rasterises the
// page into WebGL; here Chromium hands the filter the live backdrop, so
// everything in the shader that depends only on the panel's shape is computed
// once per size:
//   disp    per colour channel, where to sample the backdrop (refraction ± the
//           chromatic aberration) — R = x, G = y, for <feDisplacementMap>. The
//           red map's alpha is how much of the blurred backdrop shows (the rim
//           keeps a little of the sharp one); the green map's alpha is the
//           anti-aliased edge mask, squared
//   shade   the lighting as fin = col · gain + light: brightness, fresnel,
//           rim, inner glow, inner stroke. Grey = gain / GAIN_MAX, alpha =
//           1 − light — grey and alpha survive colour management, so gain
//           never bleeds into light
//   shadow  the drop shadow around the panel (alpha only)
// Specular, distortion, tint and saturation are 0 in every preset, so their
// terms drop out. Lengths are device px, as in the reference.
// defaults.ts + blurAmount 0.5, fresnel reflection 20% under the reference's.
// `fill` is Eos's, not the reference's: how much of a solid fill (glass.css
// --lg-fill) the glass mixes in under its lighting, making it that much more
// opaque than the reference
export const FROSTED_GLASS = {
  blurAmount: 0.5,
  brightness: 0,
  fill: 0.3,
  refraction: 0.69,
  chromAberration: 0.05,
  edgeHighlight: 0.05,
  fresnel: 0.8,
  zRadius: 40,
  shadowOpacity: 0.3,
  shadowSpread: 10,
  shadowOffsetY: 1,
};
// defaults.ts as they are: no blur
export const CLEAR_GLASS = { ...FROSTED_GLASS, blurAmount: 0 };
// defaults.ts + brightness −0.3, blurAmount 0.4
export const DARK_GLASS = { ...FROSTED_GLASS, brightness: -0.3, blurAmount: 0.4 };
// Dark Glass with a 12px rim, for thin layers: under the full 40px rim a short
// surface is all lens
export const DARK_GLASS_THIN = { ...DARK_GLASS, zRadius: 12 };
// ...and for menus over text: the reference's heaviest frost and a deeper dim,
// or the text behind competes with the rows
export const DARK_GLASS_MENU = { ...DARK_GLASS_THIN, blurAmount: 1, brightness: -0.4 };

// CSS px the shadow reaches past the panel
export const SHADOW_PAD = 20;
// the most the glass can lift what is behind it (flat middle at brightness 0:
// 1 + 0.06), so the shade map's grey never clips
export const GAIN_MAX = 1.06;

// The reference blurs with 6 rounds of a separable 9-tap Gaussian whose taps
// sit blurAmount · 2.5 texels apart; together they are one Gaussian of this σ.
const BLUR_TAPS = [0.194594, 0.121622, 0.054054, 0.016216];
const PASS_VARIANCE = 2 * BLUR_TAPS.reduce((v, w, i) => v + w * (i + 1) ** 2, 0);
export const blurSigma = (blurAmount) => Math.sqrt(6 * PASS_VARIANCE) * blurAmount * 2.5;

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
// [refraction x, y, aberration x, y, gain, light, blur mix] into out.
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
  out[4] = (1 + cfg.brightness) * (1 + 0.06 * depth) * (1 - white);
  out[5] = light * (1 - white) + white;
  out[6] = 1 - edge * 0.15;
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

// The maps for a w × h (CSS px) panel with the given corner radius, all sized
// to the panel plus SHADOW_PAD on each side — the reference samples a crop of
// the page padded like that, clamped at its edge. `scale` is the
// <feDisplacementMap> scale and `blur` the backdrop blur σ, both in CSS px.
export function glassMaps(w, h, dpr, radius, cfg = FROSTED_GLASS) {
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  const hx = W / 2, hy = H / 2;
  const r = Math.min(radius * dpr, hx, hy);
  const zR = cfg.zRadius * dpr;
  const pad = Math.round(SHADOW_PAD * dpr);
  const SW = W + pad * 2, SH = H + pad * 2, n = SW * SH;
  const edgeX = SW / 2 - 0.5, edgeY = SH / 2 - 0.5;
  const clamp = (v, e) => Math.min(Math.max(v, -e), e);

  const offsets = new Float32Array(n * 6);
  const mask = new Float32Array(n);
  const blurMix = new Float32Array(n).fill(1);
  const shade = new Uint8ClampedArray(n * 4);
  const shadow = new Uint8ClampedArray(n * 4);
  const out = new Float64Array(7);
  let max = 1e-6;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const p = y * SW + x;
      const X = x + 0.5 - SW / 2, Y = y + 0.5 - SH / 2;
      const sdf = rrSDF(X, Y, hx, hy, r);
      if (sdf > 0) {
        shadow[p * 4 + 3] = 255 * shadowAlpha(X, Y, hx, hy, r, dpr, cfg);
        continue;
      }
      glassPixel(out, X, Y, hx, hy, r, zR, cfg);
      // red, green, blue: the aberration pushes red outward, blue inward
      for (let c = 0; c < 3; c++) {
        const dx = clamp(X + out[0] + (1 - c) * out[2], edgeX) - X;
        const dy = clamp(Y + out[1] + (1 - c) * out[3], edgeY) - Y;
        offsets[p * 6 + c * 2] = dx;
        offsets[p * 6 + c * 2 + 1] = dy;
        max = Math.max(max, Math.abs(dx), Math.abs(dy));
      }
      mask[p] = 1 - smoothstep(-1.5, 0.5, sdf);
      blurMix[p] = out[6];
      shade[p * 4] = shade[p * 4 + 1] = shade[p * 4 + 2] = 255 * (out[4] / GAIN_MAX);
      shade[p * 4 + 3] = 255 * (1 - out[5]);
    }
  }

  const scale = max * 2;
  const disp = [0, 1, 2].map((c) => {
    const data = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      data[p * 4] = 255 * (offsets[p * 6 + c * 2] / scale + 0.5);
      data[p * 4 + 1] = 255 * (offsets[p * 6 + c * 2 + 1] / scale + 0.5);
      data[p * 4 + 2] = 128;
      // alpha — red: the blur mix; green: the mask squared (the reference writes
      // (fin · mask, alpha mask) with SRC_ALPHA blending, so the edge shows
      // fin · mask³ at alpha mask²)
      data[p * 4 + 3] = 255 * [blurMix[p], mask[p] ** 2, 1][c];
    }
    return data;
  });

  return { width: SW, height: SH, scale: scale / dpr, blur: blurSigma(cfg.blurAmount) / dpr, disp, shade, shadow };
}
