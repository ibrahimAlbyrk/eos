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
  // the shade as fractions: gain / GAIN_MAX and 1 − light (0, 0 outside)
  const gain = new Float32Array(n), unlit = new Float32Array(n);
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
      gain[p] = out[4] / GAIN_MAX;
      unlit[p] = 1 - out[5];
    }
  }

  const scale = max * 2;
  // map m's (0–2: disp red/green/blue, 3: shade) four channels at pixel p,
  // unrounded: the full maps and every tile are written from it
  const texel = (m, p, px) => {
    if (m === 3) {
      px[0] = px[1] = px[2] = 255 * gain[p];
      px[3] = 255 * unlit[p];
      return px;
    }
    px[0] = 255 * (offsets[p * 6 + m * 2] / scale + 0.5);
    px[1] = 255 * (offsets[p * 6 + m * 2 + 1] / scale + 0.5);
    px[2] = 128;
    // alpha — red: the blur mix; green: the mask squared (the reference writes
    // (fin · mask, alpha mask) with SRC_ALPHA blending, so the edge shows
    // fin · mask³ at alpha mask²)
    px[3] = 255 * (m === 0 ? blurMix[p] : m === 1 ? mask[p] ** 2 : 1);
    return px;
  };
  // the full maps are written only when read: a panel that splits into tiles
  // never needs them
  let full = null;
  const fullMaps = () => {
    if (full) return full;
    const px = new Float64Array(4);
    full = [0, 1, 2, 3].map((m) => {
      const data = new Uint8ClampedArray(n * 4);
      for (let p = 0; p < n; p++) data.set(texel(m, p, px), p * 4);
      return data;
    });
    return full;
  };
  // past `band` map px inside the rim every term but the pull to the centre is
  // flat (bevel and its ±2 px gradient, edge, depth, lighting), and the pull is
  // linear in x and y
  const band = Math.ceil(Math.max(zR + 2, Math.min(hx, hy) * 0.35 + 1, r)) + 3;

  return {
    width: SW, height: SH, scale: scale / dpr, blur: blurSigma(cfg.blurAmount) / dpr, pad, band, shadow,
    get disp() { return fullMaps().slice(0, 3); },
    get shade() { return fullMaps()[3]; },
    tiles: () => glassTiles(SW, SH, pad, band, texel),
  };
}

// Chromium copies every <feImage> bitmap into each compositor frame — the
// renderer serializes its pixels, the GPU process reads them back, at the
// display's rate whenever anything animates — so a map goes out as the few
// tiles that hold its detail: the four corners at full resolution, and the
// middle column and two side strips between them, which are linear along
// their length, as a few texels that <feImage>'s (cubic) upscale rebuilds
// exactly. The ring outside the panel is masked away, so it stays transparent.
// Each tile is cropped (an <feOffset> subregion) and carries an APRON of real
// texels past its crop, so the sampling at a seam sees what the full map has;
// no image reaches past the filter region (Blink would draw a subset of it).
// Rects are map px [x, y, w, h]: `place` is where the image is drawn, `crop`
// the part kept. null when the panel is too small to split; else the tile
// layout (`specs`, which placeTiles re-places for another size) and per map
// its tiles, in the specs' order.
const OUT = 2, APRON = 2;
// A strip's texels are spaced for this much growth, so re-placed for a wider
// or taller panel it still starts inside the filter region.
const GROWTH = 1.5;

// The tiles a SW × SH map splits into, as index pairs into the x / y edges:
// the corners whole, the middle column and the side strips linear.
function tileLayout(SW, SH, pad, band) {
  const edges = (S) => [pad - OUT, pad + band, S - pad - band, S - pad + OUT];
  const x = edges(SW), y = edges(SH);
  const wide = x[1] <= x[2], tall = y[1] <= y[2];
  if (!(wide || tall) || x[0] < APRON || y[0] < APRON) return null;
  // a short panel's bands meet: its left and right columns go whole
  const rows = tall ? [[0, 1], [2, 3]] : [[0, 3]];
  const cols = wide ? [[0, 1], [2, 3]] : [[0, 3]];
  const specs = [];
  for (const c of cols) for (const r of rows) specs.push({ cols: c, rows: r });
  if (wide && x[2] > x[1]) specs.push({ cols: [1, 2], rows: [0, 3], alongX: true });
  if (tall && y[2] > y[1]) for (const c of cols) specs.push({ cols: c, rows: [1, 2], alongX: false });
  return { x, y, specs };
}

// A tile's rects on the given edges. A linear tile (`n` texels) spans 2.5
// texel spacings past both ends of its crop, so no cubic tap inside the crop
// reaches the image's edge.
function tileRects({ cols, rows, alongX, n }, x, y) {
  const [cx, cy] = [x[cols[0]], y[rows[0]]], [cw, ch] = [x[cols[1]] - cx, y[rows[1]] - cy];
  const crop = [cx, cy, cw, ch];
  if (n === undefined) return { place: [cx - APRON, cy - APRON, cw + APRON * 2, ch + APRON * 2], crop };
  const s = (alongX ? cw : ch) / (n - 5);
  const place = alongX ? [cx - 2.5 * s, cy - APRON, n * s, ch + APRON * 2] : [cx - APRON, cy - 2.5 * s, cw + APRON * 2, n * s];
  return { place, crop, s };
}

function glassTiles(SW, SH, pad, band, texel) {
  const layout = tileLayout(SW, SH, pad, band);
  if (!layout) return null;
  const { x, y, specs } = layout;
  for (const t of specs) {
    if (t.alongX === undefined) continue;
    const [cx, cy, cw, ch] = tileRects(t, x, y).crop;
    const room = t.alongX ? Math.min(cx, SW - cx - cw) : Math.min(cy, SH - cy - ch);
    t.n = Math.ceil(((t.alongX ? cw : ch) * GROWTH) / (room / 2.5)) + 5;
  }
  const px = new Float64Array(4), qx = new Float64Array(4);
  let clipped = false;
  const full = (m, { place: [ix, iy, iw, ih] }) => {
    const data = new Uint8ClampedArray(iw * ih * 4);
    for (let j = 0; j < ih; j++) {
      for (let i = 0; i < iw; i++) data.set(texel(m, (iy + j) * SW + ix + i, px), (j * iw + i) * 4);
    }
    return { data, width: iw, height: ih };
  };
  // extrapolated from the crop's first and last pixel
  const linear = (m, { crop: [cx, cy, cw, ch], s }, alongX, n) => {
    const len = alongX ? cw : ch;
    const across = (alongX ? ch : cw) + APRON * 2;
    const data = new Uint8ClampedArray(n * across * 4);
    for (let k = 0; k < across; k++) {
      const at = (t) => (alongX ? (cy - APRON + k) * SW + cx + t : (cy + t) * SW + cx - APRON + k);
      texel(m, at(0), px);
      texel(m, at(len - 1), qx);
      for (let i = 0; i < n; i++) {
        // texel i's centre as an offset from the crop's first pixel centre
        const f = len > 1 ? ((i - 2) * s - 0.5) / (len - 1) : 0;
        const d = (alongX ? k * n + i : i * across + k) * 4;
        for (let c = 0; c < 4; c++) {
          const v = px[c] + (qx[c] - px[c]) * f;
          if (v < -0.5 || v > 255.5) clipped = true;
          data[d + c] = v;
        }
      }
    }
    return { data, width: alongX ? n : across, height: alongX ? across : n };
  };
  const rects = specs.map((t) => tileRects(t, x, y));
  const maps = [0, 1, 2, 3].map((m) =>
    specs.map((t, i) => ({ ...rects[i], ...(t.n === undefined ? full(m, rects[i]) : linear(m, rects[i], t.alongX, t.n)) })));
  return clipped ? null : { specs, maps };
}

// The rects of tiles laid out by glassTiles, re-placed for another size of the
// same panel (SW × SH map px): the corners keep their size and move with their
// edges, the strips stretch. null when that size splits differently or a strip
// would reach past the filter region.
export function placeTiles(specs, SW, SH, pad, band) {
  const layout = tileLayout(SW, SH, pad, band);
  const same = (a, b) => a.cols.join() === b.cols.join() && a.rows.join() === b.rows.join() && a.alongX === b.alongX;
  if (!layout || layout.specs.length !== specs.length || !specs.every((t, i) => same(t, layout.specs[i]))) return null;
  const rects = specs.map((t) => tileRects(t, layout.x, layout.y));
  const inside = ({ place: [px, py, pw, ph] }) => px >= 0 && py >= 0 && px + pw <= SW && py + ph <= SH;
  return rects.every(inside) ? rects : null;
}
