// Live visual answers: the tool input of a present call while the model writes
// it (bus topic "genui:delta", claude SDK lane only), keyed by worker + callId.
// Ephemeral, like thinkingStore: the durable tool call replaces the buffer, and
// Messages drops it once that call is in the transcript. Other lanes never
// stream — their view renders from the finished call.
//
// Emission is coalesced to one notify per animation frame (~50ms timer when
// hidden or headless). Subscribers get (workerId, structural): structural means
// a stream started or went away (the transcript's block list changes); text
// growth alone is not, so only the streaming ViewBlock re-reads it.

import { useCallback, useSyncExternalStore } from "react";

const streams = new Map(); // `${workerId}:${callId}` -> { workerId, callId, name, text, done, frozen, ended, ts, rev }
const subs = new Set();
const pending = new Map(); // workerId -> structural flag for the next flush
let flushScheduled = false;
let rafId = 0;
let timerId = 0;

const TIMER_FLUSH_MS = 50;
// A turn that ended without the call landing (interrupt, error) leaves a
// half-written view; it goes once the transcript had time to show the real one.
const ENDED_DROP_MS = 5000;

const keyOf = (workerId, callId) => `${workerId}:${callId}`;

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
  timerId = setTimeout(flush, TIMER_FLUSH_MS);
  if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
    rafId = requestAnimationFrame(flush);
  }
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// payload: GenuiDelta {workerId, callId, name, phase: start|append|stop, text}.
export function applyGenuiDelta({ workerId, callId, name, phase, text } = {}) {
  if (!workerId || !callId) return;
  const k = keyOf(workerId, callId);
  let s = streams.get(k);
  if (phase === "stop") {
    if (s && !s.done) {
      s.done = true;
      s.rev++;
      scheduleEmit(workerId, false);
    }
    return;
  }
  let structural = false;
  if (!s || phase === "start") {
    // An append with no start (the start was missed) still opens a buffer — the
    // prefix it lacks makes the JSON unreadable, so it renders as a skeleton
    // until the finished call lands.
    s = { workerId, callId, name: name ?? s?.name ?? "", text: "", done: false, frozen: phase !== "start", ended: false, ts: s?.ts ?? Date.now(), rev: 0 };
    streams.set(k, s);
    structural = true;
  }
  if (phase === "append" && !s.frozen && typeof text === "string" && text) {
    s.text += text;
    s.rev++;
  }
  scheduleEmit(workerId, structural);
}

export function getStream(workerId, callId) {
  if (!workerId || !callId) return null;
  return streams.get(keyOf(workerId, callId)) ?? null;
}

export function streamsFor(workerId) {
  const out = [];
  for (const s of streams.values()) if (s.workerId === workerId) out.push(s);
  return out;
}

export function dropStream(workerId, callId) {
  if (streams.delete(keyOf(workerId, callId))) scheduleEmit(workerId, true);
}

export function dropWorker(workerId) {
  let changed = false;
  for (const [k, s] of [...streams]) {
    if (s.workerId === workerId) { streams.delete(k); changed = true; }
  }
  if (changed) scheduleEmit(workerId, true);
}

// Workers that left the live list (useStorePrune): their buffers go.
export function pruneExcept(present) {
  const gone = new Set();
  for (const s of streams.values()) if (!present.has(s.workerId)) gone.add(s.workerId);
  for (const workerId of gone) dropWorker(workerId);
}

// The worker left its turn: whatever is still streaming will never finish.
export function endWorker(workerId) {
  let any = false;
  for (const s of streams.values()) {
    if (s.workerId === workerId && !s.ended) { s.ended = true; any = true; }
  }
  if (!any) return;
  setTimeout(() => {
    for (const [k, s] of [...streams]) {
      if (s.workerId === workerId && s.ended) { streams.delete(k); scheduleEmit(workerId, true); }
    }
  }, ENDED_DROP_MS);
}

// The SSE stream reconnected without a replay: deltas may be missing, so a
// buffer can't safely grow any more — it stays as written so far.
export function resyncGenuiStreams() {
  for (const s of streams.values()) {
    if (!s.done && !s.frozen) { s.frozen = true; s.rev++; scheduleEmit(s.workerId, false); }
  }
}

// One stream's current text + flags, re-rendering on every flush for it.
export function useStream(workerId, callId) {
  const sub = useCallback((cb) => subscribe((wid) => { if (wid === workerId) cb(); }), [workerId]);
  const snap = useCallback(() => {
    const s = getStream(workerId, callId);
    return s ? `${s.rev}:${s.done ? 1 : 0}:${s.frozen ? 1 : 0}` : "";
  }, [workerId, callId]);
  useSyncExternalStore(sub, snap, snap);
  return getStream(workerId, callId);
}

// Test-only.
export function _reset() {
  streams.clear();
  pending.clear();
  subs.clear();
}

export function _flush() {
  flush();
}
