// toastStore — the live toast list for the app-wide notification system. A
// module singleton (like ptyPanelStore / archiveStore) because producers are
// scattered across the whole app — React components, api/client.js, SSE handlers,
// store catch blocks — while the renderer is a single <ToastViewport> node in
// Shell. A singleton lets any of them fire a toast without a shared React
// context, and survives duplicate mounts (StrictMode / pane remounts).
//
// The id counter is module-owned and monotonic — not Date.now()/Math.random() —
// so ids are deterministic and tests are stable, matching ptyPanelStore's
// "the store never invents randomness" spirit.

let toasts = []; // [{ id, severity, message, title, duration, dismissible, leaving }]
let snapshot = toasts; // stable ref between emits — useSyncExternalStore contract
const subs = new Set();
let seq = 0; // monotonic id source

const MAX = 4; // hard cap on visible toasts (machines can storm push())
const DEFAULT_MS = 3000;

function emit() {
  snapshot = toasts;
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// Stable reference between emits — never rebuilt unless a mutation happens.
export function getToasts() {
  return snapshot;
}

// Add a toast; returns its id so a caller can dismiss/replace it later. Over the
// cap, the oldest is evicted so a burst can't grow the stack without bound.
export function push({
  severity = "info",
  message,
  title,
  duration = DEFAULT_MS,
  dismissible = true,
} = {}) {
  const id = ++seq;
  let next = [...toasts, { id, severity, message, title, duration, dismissible, leaving: false }];
  if (next.length > MAX) next = next.slice(next.length - MAX);
  toasts = next;
  emit();
  return id;
}

// Flip a toast to leaving so the viewport can play its slide-out; the toast
// calls dismiss() once the exit transition ends (or immediately under reduced
// motion — see Toast.jsx).
export function beginExit(id) {
  let changed = false;
  toasts = toasts.map((t) => {
    if (t.id !== id || t.leaving) return t;
    changed = true;
    return { ...t, leaving: true };
  });
  if (changed) emit();
}

export function dismiss(id) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function clear() {
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

// Test-only: reset the module singleton between cases.
export function _resetToasts() {
  toasts = [];
  snapshot = toasts;
  subs.clear();
  seq = 0;
}
