// Live reasoning/text deltas (claude-sdk, in-process lanes). Ephemeral by design:
// tokens stream in over SSE (reason "agent:delta") while a block is in flight;
// the durable record is the final canonical `message` event. Messages overlays
// live blocks and drops one once its durable block (same blockId) lands, so the
// handoff has no flash and no double-render. Mirrors terminalStore.js.
//
// Emission is coalesced: applyDelta appends text synchronously but notifies at
// most once per animation frame (~50ms timer when hidden or headless), so a fast
// token stream costs one subscriber pass per frame, not per token. Subscribers
// receive (workerId, structural): structural=true means the worker's live block
// LIST changed (block created / dropped / reclassified); text growth alone is
// structural=false, so list-level consumers (Messages) can ignore it and only
// the streaming block component re-reads its text via getBlock().

const blocks = new Map(); // `${workerId}:${blockId}` -> { workerId, blockId, channel, text, done, interrupted, ts }
const subs = new Set();   // cb(workerId, structural)

// The only channels the loop emits (ToolRuntime). An unknown/missing channel must
// NOT be silently treated as "reasoning" — that would render a malformed delta as a
// live thinking line. Fall back to "text", which is never overlaid live, so a bad
// delta can't masquerade as thinking; the durable canonical block still renders it.
const KNOWN_CHANNELS = new Set(["reasoning", "text"]);

const TIMER_FLUSH_MS = 50;

const pending = new Map(); // workerId -> structural flag accumulated for the next flush
let flushScheduled = false;
let rafId = 0;
let timerId = 0;

function flush() {
  flushScheduled = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (timerId) { clearTimeout(timerId); timerId = 0; }
  const batch = [...pending];
  pending.clear();
  for (const [workerId, structural] of batch) {
    for (const cb of subs) cb(workerId, structural);
  }
}

function scheduleEmit(workerId, structural) {
  pending.set(workerId, structural || (pending.get(workerId) ?? false));
  if (flushScheduled) return;
  flushScheduled = true;
  // The timer always arms (hidden tabs and headless tests get no frames); a
  // visible tab's rAF wins and cancels it — the timer is the backstop for a
  // frame scheduled just before the tab hides, which would never fire.
  timerId = setTimeout(flush, TIMER_FLUSH_MS);
  if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
    rafId = requestAnimationFrame(flush);
  }
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
    if (b && !b.done) { b.done = true; scheduleEmit(workerId, false); }
    return;
  }
  let b = blocks.get(k);
  let structural = false;
  if (!b) {
    // A new block means a new turn is streaming — retire the previous turn's
    // finalized (interrupted) buffers now. This covers turns that start on the
    // agent plane (queue drain, directives) and never pass through sendToAgent.
    for (const [pk, prev] of [...blocks]) {
      if (prev.workerId === workerId && prev.interrupted) blocks.delete(pk);
    }
    b = { workerId, blockId, channel: KNOWN_CHANNELS.has(channel) ? channel : "text", text: "", done: false, interrupted: false, ts: Date.now() };
    blocks.set(k, b);
    structural = true;
  }
  if (KNOWN_CHANNELS.has(channel) && b.channel !== channel) {
    // Reclassification flips whether the block is overlaid live (reasoning yes,
    // text no) — the list changed, not just the text.
    b.channel = channel;
    structural = true;
  }
  b.text += text ?? "";
  scheduleEmit(workerId, structural);
}

// The durable message for this block has landed — drop the live buffer so the
// immutable rendered block takes over with no double-render.
export function dropBlock(workerId, blockId) {
  if (blocks.delete(keyOf(workerId, blockId))) scheduleEmit(workerId, true);
}

// Turn ended without a durable block landing (interrupt / error) — KEEP the
// buffers so the streamed text survives in the transcript, but mark them
// done+interrupted. Stale finalized blocks drop at the next turn start
// (sendToAgent's dropWorker, or applyDelta's new-block sweep above).
export function finalizeWorker(workerId) {
  let changed = false;
  for (const b of blocks.values()) {
    if (b.workerId === workerId && !b.interrupted) {
      b.done = true;
      b.interrupted = true;
      changed = true;
    }
  }
  if (changed) scheduleEmit(workerId, true);
}

// Turn ended / worker idled / cleared — drop all live buffers for the worker.
export function dropWorker(workerId) {
  let changed = false;
  for (const [k, b] of [...blocks]) {
    if (b.workerId === workerId) { blocks.delete(k); changed = true; }
  }
  if (changed) scheduleEmit(workerId, true);
}

export function liveBlocksFor(workerId) {
  const out = [];
  for (const b of blocks.values()) {
    if (b.workerId === workerId) out.push({ ...b });
  }
  return out;
}

// One live block, the store's own object — for the streaming component's
// per-flush tail read. Read-only: do not mutate.
export function getBlock(workerId, blockId) {
  return blocks.get(keyOf(workerId, blockId));
}

// Drop buffers for workers no longer present (auto-shutdown / cascade death).
export function pruneExcept(presentIds) {
  const dead = new Set();
  for (const b of blocks.values()) {
    if (!presentIds.has(b.workerId)) dead.add(b.workerId);
  }
  for (const id of dead) dropWorker(id);
}
