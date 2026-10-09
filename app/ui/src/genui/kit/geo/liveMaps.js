// The WebGL budget: at most MAX_LIVE MapLibre maps alive app-wide (Chromium
// drops the oldest context past ~16, and every map holds a GPU surface). A map
// asks before going live; past the budget the least recently seen map — an
// offscreen one first — is told to snapshot itself and let go.

export const MAX_LIVE = 3;

let entries = []; // most recent first: { id, evict, visible, seen }
let clock = 0;

function tick() {
  clock += 1;
  return clock;
}

function evictOver(limit, keepId) {
  while (entries.length > limit) {
    const candidates = entries.filter((e) => e.id !== keepId);
    if (!candidates.length) return;
    const offscreen = candidates.filter((e) => !e.visible);
    const pool = offscreen.length ? offscreen : candidates;
    const victim = pool.reduce((a, b) => (a.seen <= b.seen ? a : b));
    entries = entries.filter((e) => e !== victim);
    try {
      victim.evict();
    } catch {
      /* a failing evict must not keep the slot */
    }
  }
}

// Registers (or refreshes) a live map; evicts others past the budget.
export function requestLive(id, evict) {
  const existing = entries.find((e) => e.id === id);
  if (existing) {
    existing.evict = evict;
    existing.visible = true;
    existing.seen = tick();
  } else entries.unshift({ id, evict, visible: true, seen: tick() });
  evictOver(MAX_LIVE, id);
}

export function setVisible(id, visible) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.visible = visible;
  if (visible) e.seen = tick();
}

export function releaseLive(id) {
  entries = entries.filter((e) => e.id !== id);
}

export function isLive(id) {
  return entries.some((e) => e.id === id);
}

export function liveIds() {
  return entries.map((e) => e.id);
}

export function resetLiveMapsForTests() {
  entries = [];
  clock = 0;
}
