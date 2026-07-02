// Live reasoning/text deltas (claude-sdk, in-process lanes). Ephemeral by design:
// tokens stream in over SSE (reason "agent:delta") while a block is in flight;
// the durable record is the final canonical `message` event. Messages overlays
// live blocks and drops one once its durable block (same blockId) lands, so the
// handoff has no flash and no double-render. Mirrors terminalStore.js.

const blocks = new Map(); // `${workerId}:${blockId}` -> { workerId, blockId, channel, text, done, ts }
const subs = new Set();

// The only channels the loop emits (ToolRuntime). An unknown/missing channel must
// NOT be silently treated as "reasoning" — that would render a malformed delta as a
// live thinking line. Fall back to "text", which is never overlaid live, so a bad
// delta can't masquerade as thinking; the durable canonical block still renders it.
const KNOWN_CHANNELS = new Set(["reasoning", "text"]);

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const keyOf = (workerId, blockId) => `${workerId}:${blockId}`;

export function applyDelta({ workerId, blockId, channel, phase, text }) {
  if (!workerId || !blockId) return;
  const k = keyOf(workerId, blockId);
  if (phase === "stop") {
    // Finished streaming — keep the buffer until the durable message lands
    // (dropBlock by blockId), but mark done so any in-flight indicator settles.
    const b = blocks.get(k);
    if (b && !b.done) { b.done = true; emit(); }
    return;
  }
  let b = blocks.get(k);
  if (!b) {
    b = { workerId, blockId, channel: KNOWN_CHANNELS.has(channel) ? channel : "text", text: "", done: false, ts: Date.now() };
    blocks.set(k, b);
  }
  if (KNOWN_CHANNELS.has(channel)) b.channel = channel;
  b.text += text ?? "";
  emit();
}

// The durable message for this block has landed — drop the live buffer so the
// immutable rendered block takes over with no double-render.
export function dropBlock(workerId, blockId) {
  if (blocks.delete(keyOf(workerId, blockId))) emit();
}

// Turn ended / worker idled / cleared — drop all live buffers for the worker.
export function dropWorker(workerId) {
  let changed = false;
  for (const [k, b] of [...blocks]) {
    if (b.workerId === workerId) { blocks.delete(k); changed = true; }
  }
  if (changed) emit();
}

export function liveBlocksFor(workerId) {
  const out = [];
  for (const b of blocks.values()) {
    if (b.workerId === workerId) out.push({ ...b });
  }
  return out;
}

// Drop buffers for workers no longer present (auto-shutdown / cascade death).
export function pruneExcept(presentIds) {
  const dead = new Set();
  for (const b of blocks.values()) {
    if (!presentIds.has(b.workerId)) dead.add(b.workerId);
  }
  for (const id of dead) dropWorker(id);
}
