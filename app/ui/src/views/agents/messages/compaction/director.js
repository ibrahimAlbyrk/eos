// A cancellable timeline for one compaction animation. Everything the nebula
// schedules (timers, rAF loops, tweens) goes through it, so kill() on unmount or
// agent switch stops the whole choreography at once: pending sleeps simply never
// resolve and loops stop drawing.

export function createDirector() {
  let dead = false;
  const timers = new Set();
  const d = {
    get dead() { return dead; },
    sleep(ms) {
      return new Promise((res) => {
        const id = setTimeout(() => { timers.delete(id); res(); }, ms);
        timers.add(id);
      });
    },
    every(ms, fn) {
      const id = setInterval(() => { if (!dead) fn(); }, ms);
      timers.add(id);
      return () => { clearInterval(id); timers.delete(id); };
    },
    // fn(eased, raw) each frame for `ms`; resolves at the end (never, if killed).
    tween(ms, fn, ease = easeInOutCubic) {
      return new Promise((res) => {
        const t0 = performance.now();
        const step = (now) => {
          if (dead) return;
          const t = Math.min(1, (now - t0) / ms);
          fn(ease(t), t);
          if (t < 1) requestAnimationFrame(step);
          else res();
        };
        requestAnimationFrame(step);
      });
    },
    // fn(dtMs) every frame until the returned stop() or kill().
    loop(fn) {
      let on = true;
      let last = performance.now();
      const step = (now) => {
        if (dead || !on) return;
        fn(Math.min(48, now - last));
        last = now;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return () => { on = false; };
    },
    async until(test, maxMs) {
      const end = performance.now() + maxMs;
      while (!test() && performance.now() < end) await d.sleep(60);
    },
    kill() {
      dead = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
  return d;
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
