// Send ↔ stop "ball roll" for the composer's submit button. The button is a
// sphere with the send arrow printed on its front pole and the stop square on
// its back pole; every toggle rolls it 180° forward (the front goes up and
// over, the back comes up from below) under a fixed light, so the icons bend
// over the curve instead of crossfading. Painted per pixel: each canvas pixel
// is cast onto the sphere, rotated back into the ball's own frame and inked
// from the icon's distance field.

export const ROLL_MS = 300;
const TAU = Math.PI * 2;
const MAX_SMEAR = 0.3; // radians of motion blur at top speed
const BLUR_TAPS = 5;

// The old SVG icons' geometry in sphere-radius units: a 16-unit viewBox drawn
// at 15px (arrow) and 10px (square) on a 32px ball.
const ARROW_K = 15 / 256;
const ARROW_HALF_STROKE = 0.95 * ARROW_K;
const ARROW_SEGMENTS = [
  [0, 5 * ARROW_K, 0, -4 * ARROW_K],
  [-3.5 * ARROW_K, -0.5 * ARROW_K, 0, -4 * ARROW_K],
  [3.5 * ARROW_K, -0.5 * ARROW_K, 0, -4 * ARROW_K],
];
const STOP_K = 10 / 256;
const STOP_CORNER = 3 * STOP_K;
const STOP_INNER = 7 * STOP_K - STOP_CORNER;
const DECAL_REACH = 0.4; // no decal ink beyond this distance from the poles' axis

const bezier = (a, b, s) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;

// cubic-bezier(.75, 0, .2, 1): slow ignition, hard acceleration, long glide.
// No overshoot, so the ball never rolls backward.
export function rocketEase(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0, hi = 1, s = t;
  for (let i = 0; i < 24; i++) {
    s = (lo + hi) / 2;
    if (bezier(0.75, 0.2, s) < t) lo = s;
    else hi = s;
  }
  return bezier(0, 1, s);
}

export const restAngle = (stop) => (stop ? Math.PI : 0);
export const wrapAngle = (theta) => ((theta % TAU) + TAU) % TAU;

// The next resting angle strictly ahead — the ball only ever rolls forward.
export function nextRest(theta, stop) {
  const pole = restAngle(stop);
  return Math.ceil((theta - pole) / TAU + 1e-6) * TAU + pole;
}

function segmentDistance(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const ex = px - ax - dx * t, ey = py - ay - dy * t;
  return Math.sqrt(ex * ex + ey * ey);
}

const coverage = (dist, aa) => Math.max(0, Math.min(1, 0.5 - dist / aa));

function arrowInk(u, v, aa) {
  let dist = Infinity;
  for (const seg of ARROW_SEGMENTS) dist = Math.min(dist, segmentDistance(u, v, seg));
  return coverage(dist - ARROW_HALF_STROKE, aa);
}

function stopInk(u, v, aa) {
  const qx = Math.abs(u) - STOP_INNER, qy = Math.abs(v) - STOP_INNER;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return coverage(Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - STOP_CORNER, aa);
}

// Ink coverage (0..1) at a point of the unit sphere in the ball's own frame.
// Both decals are orthographic prints: the arrow on the front (z > 0), the
// square on the back, mirrored in y so it reads upright after a half turn.
export function decalInk(x, y, z, aa) {
  return z > 0 ? arrowInk(x, y, aa) : stopInk(x, -y, aa);
}

// Paints the decals for a roll angle θ about the screen x-axis (θ > 0 carries
// the front up). `smear` is how far the ball turned since the last frame; it
// is spread over a few taps as motion blur.
export function paintBall(canvas, theta, smear, ink) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  if (!ctx || !size) return;
  const r = size / 2;
  const aa = 1.2 / r;
  const spread = Math.min(MAX_SMEAR, smear);
  const taps = spread > 0.012 ? BLUR_TAPS : 1;
  const cos = [], sin = [];
  for (let i = 0; i < taps; i++) {
    const a = theta + (taps > 1 ? spread * (i / (taps - 1) - 0.5) : 0);
    cos.push(Math.cos(a));
    sin.push(Math.sin(a));
  }
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let py = 0; py < size; py++) {
    const y = (py + 0.5 - r) / r;
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5 - r) / r;
      const r2 = x * x + y * y;
      if (r2 >= 1 || Math.abs(x) > DECAL_REACH) continue;
      const z = Math.sqrt(1 - r2);
      let a = 0;
      for (let i = 0; i < taps; i++) a += decalInk(x, y * cos[i] + z * sin[i], z * cos[i] - y * sin[i], aa);
      if (!a) continue;
      const o = (py * size + px) * 4;
      d[o] = ink[0];
      d[o + 1] = ink[1];
      d[o + 2] = ink[2];
      // the print softens where the sphere turns away at the rim
      d[o + 3] = (a / taps) * Math.min(1, z * 5) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
