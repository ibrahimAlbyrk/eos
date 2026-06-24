import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CountingSemaphore } from "../workflow/concurrency.ts";

// A controllable async task: it parks until release() is called, recording the
// max number of tasks running concurrently.
function makeTracker() {
  const state = { running: 0, peak: 0 };
  const gates: Array<() => void> = [];
  const task = () => {
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    return new Promise<void>((resolve) => {
      gates.push(() => { state.running -= 1; resolve(); });
    }).then(() => "done");
  };
  return { state, gates, task };
}

describe("CountingSemaphore", () => {
  it("never runs more than `capacity` tasks at once", async () => {
    const { state, gates, task } = makeTracker();
    const gate = new CountingSemaphore(2);
    const all = Promise.all([gate.run(task), gate.run(task), gate.run(task), gate.run(task)]);
    // Let the first wave acquire.
    await new Promise((r) => setImmediate(r));
    assert.equal(state.running, 2, "only 2 permits available");
    // Drain one at a time; the peak must stay at the cap.
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setImmediate(r));
    }
    await all;
    assert.equal(state.peak, 2);
  });

  it("releases the permit even when the wrapped task throws", async () => {
    const gate = new CountingSemaphore(1);
    await assert.rejects(gate.run(async () => { throw new Error("boom"); }), /boom/);
    // If the permit had leaked, this second acquire would hang forever.
    const out = await gate.run(async () => "recovered");
    assert.equal(out, "recovered");
  });

  it("serializes with capacity <= 0 (clamped) instead of deadlocking", async () => {
    const { state, gates, task } = makeTracker();
    const gate = new CountingSemaphore(0);
    const all = Promise.all([gate.run(task), gate.run(task)]);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.running, 1, "clamped to a serial gate");
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setImmediate(r));
    }
    await all;
    assert.equal(state.peak, 1);
  });
});
