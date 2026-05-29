import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReadinessGate } from "../readiness-gate.ts";

// Fake timer: capture scheduled callbacks and fire them by id on demand so
// the gate's quiescence/fallback logic is exercised without real time.
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (t: number) => void;
  fire: (id: number) => void;
  pending: () => number[];
} {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire: (id) => { const fn = timers.get(id); if (fn) { timers.delete(id); fn(); } },
    pending: () => [...timers.keys()],
  };
}

const MARKER = "╭";

describe("createReadinessGate", () => {
  it("fires onReady('marker') after the settle window when the marker arrives", () => {
    const t = fakeTimers();
    const reasons: string[] = [];
    const gate = createReadinessGate({
      marker: MARKER, fallbackMs: 2500, settleMs: 250,
      onReady: (r) => reasons.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    // fallback timer id=1 armed at construction. feed marker -> settle timer id=2.
    gate.feed(`\x1b[38;5;246m${MARKER}\x1b[39m header`);
    t.fire(2); // settle elapses
    assert.deepEqual(reasons, ["marker"]);
    assert.equal(gate.settled, true);
  });

  it("detects a marker split across two feed() calls via the rolling tail", () => {
    const t = fakeTimers();
    const reasons: string[] = [];
    const gate = createReadinessGate({
      marker: "AB╭", fallbackMs: 2500, settleMs: 250,
      onReady: (r) => reasons.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    gate.feed("xxxxxxxxA");   // ends with A
    gate.feed(`B${MARKER}y`); // completes "AB╭" across the boundary
    // a settle timer must now be pending; fire it.
    const settleId = t.pending().find((id) => id !== 1);
    assert.ok(settleId);
    t.fire(settleId);
    assert.deepEqual(reasons, ["marker"]);
  });

  it("restarts the settle timer when more bytes arrive before it elapses", () => {
    const t = fakeTimers();
    const reasons: string[] = [];
    const gate = createReadinessGate({
      marker: MARKER, fallbackMs: 2500, settleMs: 250,
      onReady: (r) => reasons.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    gate.feed(MARKER);        // settle timer id=2
    gate.feed("repaint...");  // restarts -> id=2 cleared, id=3 armed
    assert.equal(reasons.length, 0);          // not ready yet (still noisy)
    assert.equal(t.pending().includes(2), false); // old settle timer was cleared
    t.fire(3);
    assert.deepEqual(reasons, ["marker"]);
  });

  it("falls back to onReady('fallback') when the marker never arrives", () => {
    const t = fakeTimers();
    const reasons: string[] = [];
    createReadinessGate({
      marker: MARKER, fallbackMs: 2500, settleMs: 250,
      onReady: (r) => reasons.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire(1); // fallback timer
    assert.deepEqual(reasons, ["fallback"]);
  });

  it("settles exactly once — a later fallback after a marker settle is a no-op", () => {
    const t = fakeTimers();
    const reasons: string[] = [];
    const gate = createReadinessGate({
      marker: MARKER, fallbackMs: 2500, settleMs: 250,
      onReady: (r) => reasons.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    gate.feed(MARKER);
    const settleId = t.pending().find((id) => id !== 1);
    assert.ok(settleId);
    t.fire(settleId);   // marker settle
    t.fire(1);          // fallback fired late (already cleared, but force it)
    assert.deepEqual(reasons, ["marker"]);
  });

  it("never fires onReady after cancel()", () => {
    const t = fakeTimers();
    const reasons: string[] = [];
    const gate = createReadinessGate({
      marker: MARKER, fallbackMs: 2500, settleMs: 250,
      onReady: (r) => reasons.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    gate.feed(MARKER);
    gate.cancel();
    assert.equal(t.pending().length, 0); // both timers cleared
    assert.equal(reasons.length, 0);
    assert.equal(gate.settled, true);
  });
});
