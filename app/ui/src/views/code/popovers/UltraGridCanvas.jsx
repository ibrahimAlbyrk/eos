import { useEffect, useRef } from "react";
import { CELL, DOT, PAD_Y, FLOW_SPEED, hash, noise2, cellColor } from "../../../lib/ultraGrid.js";
import { PAD } from "../../../lib/effortScale.js";

// Formation: the swarm is born at the thumb and its frontier grows leftward
// until it reaches the left edge — cells beyond the frontier don't exist
// yet, and the frontier itself is soft and ragged.
const GROW_MS = 900;
const FRONT_SOFT = 16;

// Faithful port of the user's effort-slider.html canvas: noise-driven violet
// cells flowing right-to-left, ramping up toward the thumb, with sparkles
// and a near-thumb glow boost. Cells past the thumb are never drawn — the
// live thumb fraction comes in via `frac` (read through a ref each frame so
// drags don't restart the loop).
export function UltraGridCanvas({ frac = 1 }) {
  const ref = useRef(null);
  const fracRef = useRef(frac);
  fracRef.current = frac;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cols = Math.max(2, Math.floor(w / CELL));
    const rows = Math.max(1, Math.floor((h - PAD_Y * 2) / CELL));
    const offX = (w - cols * CELL) / 2;
    const offY = (h - rows * CELL) / 2;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf;

    const draw = (now) => {
      const elapsed = now - t0;
      const t = reduced ? 0 : elapsed / 1000;
      const flow = t * FLOW_SPEED;
      const thumbX = PAD + fracRef.current * (w - 2 * PAD);
      const grow = reduced ? 1 : Math.min(1, elapsed / GROW_MS);
      const frontierX = Math.pow(1 - grow, 3) * thumbX;
      ctx.clearRect(0, 0, w, h);
      for (let cx = 0; cx < cols; cx++) {
        const px = offX + cx * CELL + (CELL - DOT) / 2;
        const centerX = offX + cx * CELL + CELL / 2;
        if (centerX > thumbX) continue;
        const ramp = Math.pow(cx / (cols - 1), 1.9);
        const nearThumb = Math.max(0, 1 - Math.abs(centerX - thumbX) / 26);
        for (let cy = 0; cy < rows; cy++) {
          const py = offY + cy * CELL + (CELL - DOT) / 2;
          const n1 = noise2((cx + flow) * 0.45, cy * 0.8 + 3.7);
          const n2 = noise2((cx + flow * 1.8) * 0.22, cy * 0.5 + 11.2);
          const sparkle = hash(cx + Math.floor(flow * 2.4), cy * 7 + 1) > 0.965 ? 0.5 : 0;
          let bright = ramp * (0.25 + 0.75 * (n1 * 0.65 + n2 * 0.35)) + sparkle * ramp;
          bright = Math.min(1, bright + nearThumb * 0.25);
          if (bright < 0.045) continue;
          let edge = 1;
          if (grow < 1) {
            edge = (centerX - frontierX) / FRONT_SOFT + hash(cx, cy * 13 + 5) * 0.6;
            edge = Math.min(1, Math.max(0, edge));
            if (edge === 0) continue;
          }
          const shimmer = noise2((cx + flow * 0.6) * 0.18, cy * 0.3 + 27.5);
          ctx.fillStyle = cellColor(bright, shimmer);
          ctx.globalAlpha = Math.min(1, 0.15 + bright) * edge;
          ctx.beginPath();
          ctx.roundRect(px, py, DOT, DOT, 1);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="ep-grid" />;
}
