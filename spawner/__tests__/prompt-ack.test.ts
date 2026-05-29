import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptAckWatchdog } from "../prompt-ack.ts";

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

describe("createPromptAckWatchdog", () => {
  it("does not report when acknowledged before the window", () => {
    const t = fakeTimers();
    const unacked: number[] = [];
    const w = createPromptAckWatchdog({
      ackWindowMs: 15000, now: () => 0, onUnacknowledged: (ms) => unacked.push(ms),
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.arm();
    w.acknowledge();
    t.fire(1); // window timer fires late — must short-circuit
    assert.deepEqual(unacked, []);
    assert.equal(t.pending().length, 0);
  });

  it("reports once with elapsed time when never acknowledged", () => {
    const t = fakeTimers();
    let clock = 100;
    const unacked: number[] = [];
    const w = createPromptAckWatchdog({
      ackWindowMs: 15000, now: () => clock, onUnacknowledged: (ms) => unacked.push(ms),
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.arm();          // armedAt = 100
    clock = 15100;    // window elapsed
    t.fire(1);
    assert.deepEqual(unacked, [15000]);
  });

  it("does not report after cancel()", () => {
    const t = fakeTimers();
    const unacked: number[] = [];
    const w = createPromptAckWatchdog({
      ackWindowMs: 15000, now: () => 0, onUnacknowledged: (ms) => unacked.push(ms),
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.arm();
    w.cancel();
    t.fire(1);
    assert.deepEqual(unacked, []);
  });

  it("acknowledge() is idempotent", () => {
    const t = fakeTimers();
    const unacked: number[] = [];
    const w = createPromptAckWatchdog({
      ackWindowMs: 15000, now: () => 0, onUnacknowledged: (ms) => unacked.push(ms),
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.arm();
    w.acknowledge();
    w.acknowledge(); // no throw, no double clear
    assert.deepEqual(unacked, []);
  });

  it("re-arm is a no-op (single window)", () => {
    const t = fakeTimers();
    const w = createPromptAckWatchdog({
      ackWindowMs: 15000, now: () => 0, onUnacknowledged: () => {},
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.arm();
    w.arm(); // second arm ignored
    assert.equal(t.pending().length, 1);
  });

  it("acknowledge before arm is a no-op", () => {
    const t = fakeTimers();
    const unacked: number[] = [];
    const w = createPromptAckWatchdog({
      ackWindowMs: 15000, now: () => 0, onUnacknowledged: (ms) => unacked.push(ms),
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    w.acknowledge(); // nothing armed yet
    w.arm();
    t.fire(1);       // not acked -> reports
    assert.deepEqual(unacked, [0]);
  });
});
