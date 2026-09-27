// Painters for the compaction card's living details: the tiny galaxy in its
// icon slot and the stars scattered across its header. Both are shared with the
// nebula overlay, which flies real grains to exactly these spots before handing
// over — so the layouts are deterministic per card (seeded by its event id).

const INK = ["233,233,233", "200,200,200", "150,190,245", "110,164,232"];
const STAR_INK = ["200,220,250", "150,190,245"];

// Small deterministic PRNG (mulberry32) — same seed, same sky.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sizeCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

export const GALAXY = { rx: 13, ry: 5, tilt: -0.35, n: 95 };

/** Stars in the card header: [{ x, y, s, a, c, ph, w }], clear of the icon slot. */
export function starLayout(seed, width, height, count = 100) {
  const r = prng(seed);
  return Array.from({ length: count }, () => ({
    x: 48 + r() * Math.max(1, width - 54), y: 4 + r() * Math.max(1, height - 8),
    s: 1 + r() * 0.6, a: 0.2 + r() * 0.4, c: STAR_INK[(r() * STAR_INK.length) | 0],
    ph: r() * 6.28, w: 0.0008 + r() * 0.0012,
  }));
}

/** A turning galaxy: the nebula's own orbit model at icon size. */
export function createGalaxy(seed) {
  const r = prng(seed);
  const stars = Array.from({ length: GALAXY.n }, () => ({
    hr: 0.1 + 0.9 * Math.pow(r(), 1.3), ha: r() * Math.PI * 2,
    a: 0.35 + r() * 0.6, s: 0.9 + r() * 0.6, c: INK[(r() * INK.length) | 0],
  }));
  return {
    // pace scales the spin (1 = resting speed).
    paint(g, w, h, dt, pace) {
      g.clearRect(0, 0, w, h);
      g.save();
      g.translate(w / 2, h / 2);
      g.rotate(GALAXY.tilt);
      g.save();
      g.scale(Math.min(GALAXY.rx * 0.35, 18), Math.max(3, GALAXY.ry * 1.6));
      const glow = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      glow.addColorStop(0, "rgba(215,232,255,.85)");
      glow.addColorStop(0.35, "rgba(110,164,232,.3)");
      glow.addColorStop(1, "rgba(110,164,232,0)");
      g.fillStyle = glow;
      g.beginPath();
      g.arc(0, 0, 1, 0, Math.PI * 2);
      g.fill();
      g.restore();
      for (const st of stars) {
        st.ha += (0.0011 / (0.35 + st.hr)) * dt * 0.5 * pace;
        const depth = Math.sin(st.ha);
        g.globalAlpha = st.a * (depth > 0 ? 1 : 0.45);
        g.fillStyle = `rgb(${st.c})`;
        g.fillRect(Math.cos(st.ha) * GALAXY.rx * st.hr, depth * GALAXY.ry * st.hr, st.s, st.s);
      }
      g.restore();
      g.globalAlpha = 1;
    },
  };
}

export function paintStars(g, w, h, stars, t) {
  g.clearRect(0, 0, w, h);
  for (const s of stars) {
    g.globalAlpha = s.a * (0.55 + 0.45 * Math.sin(t * s.w + s.ph));
    g.fillStyle = `rgb(${s.c})`;
    g.fillRect(s.x, s.y, s.s, s.s);
  }
  g.globalAlpha = 1;
}
