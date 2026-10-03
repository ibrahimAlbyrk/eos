// What this tab has on screen — the workers whose transcript a pane shows and
// the terminals an xterm is attached to. The daemon then streams the high-volume
// live topics (agent:delta, pty:data) only for these, instead of every worker's
// tokens and every terminal's output (over a peer link, most of the traffic).
//
// A worker coming into view missed its earlier deltas: the focus answer seeds
// its live buffers with the text streamed so far. Deltas carry their offset in
// the block, so seed and deltas merge exactly whichever arrives first.
// A terminal coming into view re-reads its screen anyway (TerminalView attach),
// and its replay gate catches a gap left by the focus arriving late.

import { api } from "../api/client.js";
import { seedLive } from "./thinkingStore.js";

const workers = new Map(); // id -> refcount
const ptys = new Map();
const seedDue = new Set(); // workers added since the last send
let scheduled = false;
let sending = false;
let sendAgain = false;

function retain(map, id, onAdd) {
  if (!id) return () => {};
  const n = map.get(id) ?? 0;
  map.set(id, n + 1);
  if (n === 0) { onAdd?.(id); schedule(); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (map.get(id) ?? 1) - 1;
    if (left > 0) { map.set(id, left); return; }
    map.delete(id);
    seedDue.delete(id);
    schedule();
  };
}

export function retainWorker(id) {
  return retain(workers, id, (w) => seedDue.add(w));
}

export function retainPty(id) {
  return retain(ptys, id);
}

// The /stream query that declares the current focus (sent on every connect).
export function focusQuery() {
  const enc = (m) => [...m.keys()].map(encodeURIComponent).join(",");
  return `&focus=${enc(workers)}&ptys=${enc(ptys)}`;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // One request per burst (a pane switch releases one worker and retains another).
  queueMicrotask(() => { scheduled = false; void send(); });
}

// One request at a time: two in flight could land out of order and leave the
// daemon on the older set.
async function send() {
  if (sending) { sendAgain = true; return; }
  sending = true;
  try {
    do {
      sendAgain = false;
      const seeding = [...seedDue];
      seedDue.clear();
      const r = await api.setStreamFocus({ workers: [...workers.keys()], ptys: [...ptys.keys()] }).catch(() => null);
      if (!r?.ok || !Array.isArray(r.body?.live)) continue;
      for (const id of seeding) {
        if (workers.has(id)) seedLive(id, r.body.live.filter((b) => b.workerId === id));
      }
    } while (sendAgain);
  } finally {
    sending = false;
  }
}

// Test-only.
export function _resetStreamFocus() {
  workers.clear();
  ptys.clear();
  seedDue.clear();
  scheduled = false;
  sending = false;
  sendAgain = false;
}
