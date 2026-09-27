// The compaction choreography (the locked "Nebula · in place" design).
//
//   start    every visible block loosens into dust where it stands; an inhale
//            spreading from the middle swirls it into a slowly turning cloud,
//            with the summary sections rolling by underneath while the
//            summarizer runs (however long that takes).
//   complete the same dust writes the summary card's text left to right; ~100
//            grains settle into the card as stars; the rest of the cloud shrinks
//            into the icon slot and lives on there as a tiny galaxy.
//   fail     the cloud fades out; the caller brings the transcript back.

import { createDust } from "./dust.js";
import { lerp, rand } from "./director.js";
import { GALAXY, starLayout } from "./galaxy.js";

const ROLL = ["Primary request", "Key concepts", "Files & code", "Errors & fixes", "User messages", "Pending tasks", "Current work"];
const RAMP_MS = 1300;
const SWIRL = 0.00045;
const CLOUD_INK = [[233, 233, 233], [200, 200, 200], [150, 190, 245], [110, 164, 232]];

function createLabel(frame, x, y, meta) {
  const el = document.createElement("div");
  el.className = "nb-label";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerHTML = `<div class="nb-title">Rewriting conversation</div><div class="nb-roll"><span></span></div><div class="nb-meta"></div>`;
  el.querySelector(".nb-roll span").textContent = ROLL[0];
  el.querySelector(".nb-meta").textContent = meta;
  frame.append(el);
  const ease = "cubic-bezier(.16,1,.3,1)";
  el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 560, easing: ease, fill: "both" });
  return {
    roll(text) {
      const box = el.querySelector(".nb-roll");
      const old = box.lastElementChild;
      const nu = document.createElement("span");
      nu.textContent = text;
      box.append(nu);
      old.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], { duration: 380, easing: ease, fill: "both" })
        .finished.then(() => old.remove(), () => {});
      nu.animate([{ transform: "translateY(100%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], { duration: 380, easing: ease, fill: "both" });
    },
    hide() {
      el.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)" }], { duration: 240, fill: "both" })
        .finished.then(() => el.remove(), () => el.remove());
    },
    remove: () => el.remove(),
  };
}

// Opened mid-compaction (reload / agent switch): no transcript to dissolve, so
// the cloud simply appears.
function seedCloud(E, neb, n) {
  for (let i = 0; i < n; i++) {
    const hr = 0.12 + 0.88 * Math.pow(Math.random(), 1.3);
    const ha = rand(0, Math.PI * 2);
    E.spawn({
      x: neb.x + Math.cos(ha) * neb.rx * hr, y: neb.y + Math.sin(ha) * neb.ry * hr,
      hr, ha, a: rand(0.35, 0.9), rgb: CLOUD_INK[(Math.random() * CLOUD_INK.length) | 0],
    });
  }
}

export function startNebula(d, { frame, band, blocks, onHide, meta }) {
  const E = createDust(d, { frame, band });
  const rx = Math.min(170, E.F.width * 0.36);
  const neb = { x: E.center.x, y: E.center.y, rx, ry: rx * 0.42, breath: 1, k: 0.00008 };

  E.pre = () => { neb.breath = 1 + 0.06 * Math.sin(E.time * 0.002); };
  // Each grain orbits its own ellipse; inner rings turn faster. The pull eases
  // in and curves along the cloud's rotation instead of diving straight.
  E.field = (p, dt) => {
    if (p.hr == null) {
      p.hr = 0.12 + 0.88 * Math.pow(Math.random(), 1.3);
      p.ha = Math.atan2((p.y - neb.y) / neb.ry, (p.x - neb.x) / neb.rx);
    }
    p.ha += (0.0011 / (0.35 + p.hr)) * dt;
    const tx = neb.x + Math.cos(p.ha) * neb.rx * p.hr * neb.breath;
    const ty = neb.y + Math.sin(p.ha) * neb.ry * p.hr * neb.breath;
    const ramp = Math.min(1, (p.age - p.float) / RAMP_MS);
    const k = neb.k * ramp * ramp;
    p.vx += (tx - p.x) * k * dt;
    p.vy += (ty - p.y) * k * dt;
    const dx = p.x - neb.x, dy = p.y - neb.y, dist = Math.hypot(dx, dy) || 1;
    const sw = SWIRL * ramp * Math.min(1, dist / 120) * (neb.k > 0.0001 ? 0.3 : 1);
    p.vx += (-dy / dist) * sw * dt;
    p.vy += (dx / dist) * sw * dt;
  };

  let label = null;
  let stopRoll = () => {};
  const ready = (async () => {
    if (blocks.length) {
      await E.dissolve(blocks, onHide);
      await d.sleep(1900);
    } else {
      onHide?.();
      seedCloud(E, neb, E.budget * 0.3);
      await d.sleep(200);
    }
    label = createLabel(frame, neb.x, neb.y + neb.ry + 34, meta);
    let i = 0;
    stopRoll = d.every(440, () => label.roll(ROLL[++i % ROLL.length]));
  })();

  const settleText = async (card, assemblingClass) => {
    // Sample the card's glyphs with its real colors: the class hiding its text is
    // lifted only for the synchronous style reads, so nothing paints in between.
    card.classList.remove(assemblingClass);
    const pending = E.targets(card);
    card.classList.add(assemblingClass);
    let targets = await pending;
    const pool = E.parts.filter((p) => p.state === 1 || p.state === 2);
    const cap = Math.floor(pool.length * 0.8);
    if (targets.length > cap) targets = targets.filter(() => Math.random() < cap / targets.length);
    const byX = (a, b) => a.x - b.x;
    const src = [...pool].sort(byX);
    targets.sort(byX);
    const box = E.boxOf(card);
    const every = src.length / Math.max(1, targets.length);
    const used = new Set();
    targets.forEach((tg, i) => {
      const p = src[Math.min(src.length - 1, Math.floor(i * every))];
      used.add(p);
      Object.assign(p, {
        state: 2, tx: tg.x, ty: tg.y, k: rand(0.00022, 0.0003), sTo: 1.1, a: tg.a,
        seekAt: E.time + ((tg.x - box.x) / box.w) * 520 + rand(0, 160),
        c: E.colorOf(tg.r, tg.g, tg.b),
      });
    });
    return { used, rest: pool.filter((p) => !used.has(p)) };
  };

  return {
    // card: the rendered card element (text hidden by `assemblingClass`), with
    // .cmp-seal-cv (icon slot) and .cmp-star-cv (star field) inside. onSettle /
    // onReveal advance the card: show its galaxy + stars, then its real text.
    async complete(card, { assemblingClass, cardSeed, onSettle, onReveal }) {
      await ready;
      stopRoll();
      label?.hide();
      E.maxSpeed = 1.4;
      const { used, rest } = await settleText(card, assemblingClass);

      const sky = E.boxOf(card.querySelector(".cmp-star-cv"));
      const layout = starLayout(cardSeed, sky.w, sky.h);
      // Stars are taken evenly across the leftover so the cloud keeps its shape.
      const step = Math.max(1, Math.floor(rest.length / layout.length));
      const stars = rest.filter((_, i) => i % step === 0).slice(0, layout.length);
      const starSet = new Set(stars);
      stars.forEach((p, i) => {
        const st = layout[i];
        const rgb = st.c.split(",").map(Number);
        Object.assign(p, {
          state: 2, tx: sky.x + st.x, ty: sky.y + st.y, k: 0.00016, sTo: st.s, a: st.a,
          seekAt: E.time + rand(0, 600), c: E.colorOf(...rgb),
        });
      });
      E.regroup();

      // The rest of the cloud, still turning, shrinks into the icon slot.
      const ic = E.boxOf(card.querySelector(".cmp-seal-cv"));
      const from = { x: neb.x, y: neb.y, rx: neb.rx, ry: neb.ry };
      const to = { x: ic.x + ic.w / 2, y: ic.y + ic.h / 2, rx: GALAXY.rx, ry: GALAXY.ry };
      neb.k = 0.0003;
      await d.tween(1150, (k) => { for (const key in to) neb[key] = lerp(from[key], to[key], k); });
      onSettle();
      for (const p of rest) if (!starSet.has(p)) p.fade = rand(260, 480);
      await d.until(() => stars.every((p) => E.time > p.seekAt + 900), 1400);
      for (const p of stars) p.fade = 260;
      await d.until(() => [...used].every((p) => E.time > p.seekAt + 700), 1600);
      onReveal();
      for (const p of used) p.fade = rand(240, 420);
      await d.until(() => E.alive() === 0, 1200);
      E.destroy();
    },
    async fail() {
      await ready;
      stopRoll();
      label?.hide();
      E.fadeAll(300, 700);
      await d.until(() => E.alive() === 0, 1400);
      E.destroy();
    },
    destroy() {
      d.kill();
      E.destroy();
      label?.remove();
    },
  };
}

// Reduced motion: no dust — the transcript fades, a still label waits, the card
// simply appears.
export function startQuiet(frame, { onHide, meta }) {
  onHide?.();
  const el = document.createElement("div");
  el.className = "nb-label nb-label--quiet";
  el.style.left = "50%";
  el.style.top = "38%";
  el.innerHTML = `<div class="nb-title">Rewriting conversation…</div><div class="nb-meta"></div>`;
  el.querySelector(".nb-meta").textContent = meta;
  frame.append(el);
  return {
    async complete(_card, { onSettle, onReveal }) { el.remove(); onSettle(); onReveal(); },
    async fail() { el.remove(); },
    destroy() { el.remove(); },
  };
}
