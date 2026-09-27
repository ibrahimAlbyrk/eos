// Dust engine for the compaction nebula. It rasterizes the real transcript —
// every glyph at its laid-out position, bubbles, code chips, icons — loosens it
// into grains where it stands, and runs a pluggable force field over them.
// Canvases live in `frame` (position:relative); `band` is the visible scroll
// viewport, outside of which nothing is sampled or drawn.

import { rand } from "./director.js";

const XMLNS = "http://www.w3.org/2000/svg";
const DPR = Math.min(2, window.devicePixelRatio || 1);

const metricsCache = new Map();
function fontMetrics(ctx, font) {
  let m = metricsCache.get(font);
  if (!m) {
    const t = ctx.measureText("Hg");
    m = { asc: t.fontBoundingBoxAscent, desc: t.fontBoundingBoxDescent };
    metricsCache.set(font, m);
  }
  return m;
}

async function svgImage(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", XMLNS);
  const src = clone.outerHTML.replace(/currentColor/g, getComputedStyle(svg).color);
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src);
  try { await img.decode(); } catch { /* an undecodable icon just doesn't turn to dust */ }
  return img;
}

function canvas2d(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * DPR);
  c.height = Math.ceil(h * DPR);
  const g = c.getContext("2d");
  g.scale(DPR, DPR);
  return [c, g];
}

// Text laid out but not shown (opacity 0 / hidden ancestors inside the element).
function concealed(node, root) {
  for (let n = node; n && n !== root; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.opacity === "0" || cs.visibility === "hidden") return true;
  }
  return false;
}

// Paints one element as the browser laid it out: fills (bubbles, code chips)
// into `bg`, each glyph and icon into `fg`, relative to the element box.
async function rasterize(el, origin) {
  const r = el.getBoundingClientRect();
  const w = r.width + 2, h = r.height + 2;
  const [bg, bx] = canvas2d(w, h);
  const [fg, fx] = canvas2d(w, h);
  for (const node of [el, ...el.querySelectorAll("*")]) {
    const cs = getComputedStyle(node);
    const c = cs.backgroundColor;
    if (!c || c === "transparent" || /,\s*0\)$/.test(c) || concealed(node, el)) continue;
    const b = node.getBoundingClientRect();
    bx.fillStyle = c;
    bx.beginPath();
    bx.roundRect(b.left - r.left, b.top - r.top, b.width, b.height, parseFloat(cs.borderTopLeftRadius) || 0);
    bx.fill();
  }
  const range = document.createRange();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent;
    if (!text.trim() || concealed(n.parentElement, el)) continue;
    const cs = getComputedStyle(n.parentElement);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    fx.font = font;
    fx.fillStyle = cs.color;
    const m = fontMetrics(fx, font);
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const b = range.getBoundingClientRect();
      if (!b.width) continue;
      fx.fillText(text[i], b.left - r.left, b.top - r.top + (b.height - (m.asc + m.desc)) / 2 + m.asc);
    }
  }
  // Every style/geometry read happens synchronously above and here (icon colors
  // included) — a caller may flip a class around this call; only decoding awaits.
  const icons = [...el.querySelectorAll("svg")]
    .filter((svg) => !concealed(svg, el))
    .map((svg) => ({ box: svg.getBoundingClientRect(), img: svgImage(svg) }));
  const out = { x: r.left - origin.left, y: r.top - origin.top, w, h, fg, bg };
  for (const ic of icons) fx.drawImage(await ic.img, ic.box.left - r.left, ic.box.top - r.top, ic.box.width, ic.box.height);
  return out;
}

// One sample per stride cell (jittered so no grid shows), in CSS px.
function sample(c, stepCss, minA, jitter) {
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const stride = Math.max(1, Math.round(stepCss * DPR));
  const out = [];
  for (let y = 0; y < c.height; y += stride) {
    for (let x = 0; x < c.width; x += stride) {
      const sx = jitter ? Math.min(c.width - 1, x + ((Math.random() * stride) | 0)) : x;
      const sy = jitter ? Math.min(c.height - 1, y + ((Math.random() * stride) | 0)) : y;
      const i = (sy * c.width + sx) * 4;
      if (data[i + 3] > minA) out.push({ x: sx / DPR, y: sy / DPR, r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] / 255 });
    }
  }
  return out;
}

export function createDust(d, { frame, band: bandEl }) {
  const F = frame.getBoundingClientRect();
  const layer = (cls) => {
    const c = document.createElement("canvas");
    c.className = "nb-canvas " + cls;
    c.width = Math.round(F.width * DPR);
    c.height = Math.round(F.height * DPR);
    frame.append(c);
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    return { c, g };
  };
  const rest = layer("nb-rest");
  const dust = layer("nb-dust");
  const B = bandEl.getBoundingClientRect();
  const band = { top: B.top - F.top, bottom: B.bottom - F.top };
  rest.c.style.webkitMaskImage = rest.c.style.maskImage =
    `linear-gradient(to bottom, transparent ${band.top}px, #000 ${band.top + 26}px, #000 ${band.bottom}px, transparent ${band.bottom}px)`;
  const narrow = F.width < 600 || matchMedia("(pointer: coarse)").matches;

  const colors = [], colorIndex = new Map(), groups = [];
  const E = {
    F, band, parts: [], sparks: [], pieces: [], time: 0,
    field: null, pre: null, damp: 0.993, trail: 0.55, maxSpeed: 0.9,
    budget: narrow ? 3000 : 6500,
    center: { x: F.width / 2, y: band.top + (band.bottom - band.top) * 0.42 },
    colorOf(r, g, b) {
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let i = colorIndex.get(key);
      if (i == null) {
        i = colors.length;
        colorIndex.set(key, i);
        colors.push(`rgb(${r},${g},${b})`);
        groups.push([]);
      }
      return i;
    },
    regroup() {
      for (const gr of groups) gr.length = 0;
      for (const p of E.parts) if (p.state !== 3) groups[p.c].push(p);
    },
    alive: () => E.parts.reduce((n, p) => n + (p.state !== 3 ? 1 : 0), 0),
    fadeAll(minMs, maxMs) { for (const p of E.parts) if (p.state !== 3) p.fade = rand(minMs, maxMs); },
    spawn(p) {
      const q = { vx: 0, vy: 0, s: 2, a: 1, f: 1, state: 1, age: 0, float: 0, seed: rand(0, 6.283), ...p };
      q.c = E.colorOf(...q.rgb);
      E.parts.push(q);
      groups[q.c].push(q);
      return q;
    },
  };

  // Loosens every visible block where it stands: all at once, each grain at its
  // own random moment, while the crisp copy fades under them. `onHide` runs in
  // the frame the canvas copy first paints — hide the DOM blocks there.
  E.dissolve = async (blocks, onHide) => {
    const pieces = [];
    for (const b of blocks) pieces.push(await rasterize(b, F));
    const fg = [], bg = [];
    const t0 = E.time + 80;
    for (const pc of pieces) {
      pc.t0 = t0;
      for (const s of sample(pc.fg, 2, 90, true)) fg.push([pc, s]);
      for (const s of sample(pc.bg, 4, 30, true)) bg.push([pc, s]);
    }
    const keepFg = Math.min(1, (E.budget * 0.85) / Math.max(1, fg.length));
    const keepBg = Math.min(1, (E.budget * 0.15) / Math.max(1, bg.length));
    const add = ([pc, s], isBg) => {
      const x = pc.x + s.x, y = pc.y + s.y;
      if (y < band.top + 4 || y > band.bottom) return;
      E.spawn({
        x, y, s: isBg ? 2.5 : 2, a: isBg ? s.a * 0.45 : s.a, rgb: [s.r, s.g, s.b],
        state: 0, rel: t0 + rand(60, 460),
        // Grains near the middle are gathered first: an inhale spreading outward.
        float: rand(480, 820) + Math.hypot(x - E.center.x, y - E.center.y) * 0.9,
      });
    };
    for (const x of fg) if (Math.random() < keepFg) add(x, false);
    for (const x of bg) if (Math.random() < keepBg) add(x, true);
    E.pieces.push(...pieces);
    E.hideNext = onHide;
    await d.until(() => E.time > t0 + 520, 4000);
  };

  // Glyph pixels of an element (e.g. the summary card) as seek targets.
  E.targets = async (el) => {
    const pc = await rasterize(el, F);
    return sample(pc.fg, 1, 110, false).map((s) => ({ ...s, x: pc.x + s.x, y: pc.y + s.y }));
  };

  // A box's position in engine (frame) coordinates.
  E.boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - F.left, y: r.top - F.top, w: r.width, h: r.height };
  };

  const update = (dt) => {
    const t = E.time;
    const damp = Math.pow(E.damp, dt);
    for (const p of E.parts) {
      if (p.state === 3) continue;
      if (p.state === 0) {
        if (t < p.rel) continue;
        p.state = 1;
        // A faint outward breath from the middle, then drift.
        p.vx = rand(-0.012, 0.012) + (p.x - E.center.x) * 0.00005;
        p.vy = rand(-0.024, 0.004) + (p.y - E.center.y) * 0.00005;
      }
      p.age += dt;
      if (p.age < p.float) {
        p.vx += Math.sin(p.y * 0.021 + t * 0.0017 + p.seed) * 0.00007 * dt;
        p.vy += (Math.cos(p.x * 0.019 + t * 0.0013 + p.seed) * 0.00007 - 0.000008) * dt;
      } else if (p.state === 2 && t >= p.seekAt) {
        const k = p.k, c = 2 * Math.sqrt(k);
        p.vx += ((p.tx - p.x) * k - p.vx * c) * dt;
        p.vy += ((p.ty - p.y) * k - p.vy * c) * dt;
        if (p.sTo != null) p.s += (p.sTo - p.s) * Math.min(1, dt / 160);
      } else if (E.field) E.field(p, dt);
      if (p.state !== 2 || t < p.seekAt) {
        p.vx *= damp;
        p.vy *= damp;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > E.maxSpeed) { p.vx *= E.maxSpeed / sp; p.vy *= E.maxSpeed / sp; }
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.fade) {
        p.f -= dt / p.fade;
        if (p.f <= 0) p.state = 3;
      }
    }
  };

  const draw = () => {
    const g = dust.g;
    g.globalCompositeOperation = "destination-out";
    g.globalAlpha = 1;
    g.fillStyle = `rgba(0,0,0,${E.trail})`;
    g.fillRect(0, 0, F.width, F.height);
    g.globalCompositeOperation = "source-over";
    for (let i = 0; i < groups.length; i++) {
      const list = groups[i];
      if (!list.length) continue;
      g.fillStyle = colors[i];
      for (const p of list) {
        if (p.state === 0 || p.state === 3) continue;
        g.globalAlpha = p.a * p.f;
        g.fillRect(p.x, p.y, p.s, p.s);
      }
    }
    // Freshly loosened grains flash pale blue as they let go.
    g.globalCompositeOperation = "lighter";
    g.fillStyle = "rgb(150,190,245)";
    for (const p of E.parts) {
      if (p.state === 0 || p.state === 3 || p.age > 340) continue;
      g.globalAlpha = (1 - p.age / 340) * 0.4 * p.a;
      g.fillRect(p.x - 0.5, p.y - 0.5, p.s + 1, p.s + 1);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";

    const rg = rest.g;
    rg.clearRect(0, 0, F.width, F.height);
    for (const pc of E.pieces) {
      if (pc.done) continue;
      const k = (E.time - pc.t0 - 60) / 400;
      if (k >= 1) { pc.done = true; continue; }
      rg.globalAlpha = 1 - Math.max(0, k);
      rg.drawImage(pc.bg, pc.x, pc.y, pc.w, pc.h);
      rg.drawImage(pc.fg, pc.x, pc.y, pc.w, pc.h);
    }
    rg.globalAlpha = 1;
  };

  E.stop = d.loop((dt) => {
    for (let left = dt; left > 0; left -= 16) {
      const step = Math.min(16, left);
      E.time += step;
      E.pre?.(step);
      update(step);
    }
    draw();
    if (E.hideNext) { E.hideNext(); E.hideNext = null; }
  });
  E.destroy = () => { E.stop(); rest.c.remove(); dust.c.remove(); };
  return E;
}
