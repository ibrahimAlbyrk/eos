// Reads only other views need wait for the first paint. At start-up the window draws
// from the boot snapshot; Settings sections, memories, templates, jobs, the update, peers,
// editors, plan usage and slash commands load once it has painted (or at once, when
// their view opens later). Nothing waits unless start-up asked for it (main.jsx), so
// tests and later calls run as before.

let waiting = null;
let release = null;

export function holdUntilFirstPaint() {
  if (waiting) return;
  waiting = new Promise((resolve) => { release = resolve; });
}

export function firstPaintDone() {
  release?.();
  release = null;
  waiting = null;
}

// Runs `fn` now, or once the first paint is done → its result, as a promise.
export function afterFirstPaint(fn) {
  return waiting ? waiting.then(() => fn()) : Promise.resolve(fn());
}

// Opens the gate once the window has painted what it has and is idle (or after
// `timeout` ms of being busy).
export function releaseAfterPaint({ timeout = 1000 } = {}) {
  const idle = typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout })
    : (cb) => setTimeout(cb, 0);
  const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
  frame(() => idle(firstPaintDone));
}
