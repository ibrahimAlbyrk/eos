// Result-coupled progress for the push button's perimeter ring — a <path>
// normalized with pathLength=1 and born hidden (strokeDasharray/offset 1).
// NProgress pattern: while the push is in flight the ring trickles toward a
// cap it can never pass, so it cannot sit at 100% before the push actually
// succeeded; the real result then sprints it to full from wherever it is.

const DEFAULTS = {
  cap: 0.88,
  trickleMs: 9000,
  trickleTau: 1800,
  trickleSteps: 16,
  sprintMs: 240,
  sweepMs: 480,
};

// Samples p(t) = cap·(1 − e^(−t/τ)) into evenly spaced keyframes; the linear
// segments between samples approximate the curve closely enough at 16 steps
// (fast first second, long visible crawl, parks just above 1 − cap).
export function trickleKeyframes(cap, durationMs, tauMs, steps) {
  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * durationMs;
    frames.push({ strokeDashoffset: 1 - cap * (1 - Math.exp(-t / tauMs)) });
  }
  return frames;
}

export function createRingProgress(pathEl, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let trickleAnim = null;

  const currentOffset = () => {
    const v = parseFloat(getComputedStyle(pathEl).strokeDashoffset);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  };
  const run = (frames, duration, easing) =>
    pathEl.animate(frames, { duration, easing, fill: "forwards" });

  return {
    trickle() {
      trickleAnim = run(
        trickleKeyframes(o.cap, o.trickleMs, o.trickleTau, o.trickleSteps),
        o.trickleMs,
        "linear",
      );
    },
    // Sprint to full from the current offset. Read before cancel — cancel()
    // snaps the offset back to the hidden base value.
    async finish() {
      const from = currentOffset();
      trickleAnim?.cancel();
      trickleAnim = null;
      await run(
        [{ strokeDashoffset: from }, { strokeDashoffset: 0 }],
        o.sprintMs,
        "cubic-bezier(.3,.1,.3,1)",
      ).finished;
    },
    // Push already resolved before the ring was due: one uninterrupted draw.
    async sweep() {
      await run(
        [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
        o.sweepMs,
        "cubic-bezier(.65,0,.35,1)",
      ).finished;
    },
    // Push failed: freeze the partial ring where it is (CSS recolors it).
    fail() {
      trickleAnim?.pause();
      trickleAnim = null;
    },
  };
}
