import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeIdleSuspend, type IdleSuspendDeps } from "../idle-suspend.ts";

// A manual clock: scheduled callbacks run only when the test advances time.
function build(over: Partial<IdleSuspendDeps> = {}) {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let nextId = 0;
  const suspended: string[] = [];
  const idle = makeIdleSuspend({
    idleMs: 1000,
    keepReason: () => null,
    suspend: (id) => suspended.push(id),
    schedule: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return () => pending.delete(id);
    },
    ...over,
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...pending]) {
      if (t.at <= now) { pending.delete(id); t.fn(); }
    }
  };
  return { idle, suspended, advance, pendingCount: () => pending.size };
}

describe("idle suspend", () => {
  it("suspends a worker that stays IDLE for the idle period", () => {
    const { idle, suspended, advance } = build();
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    advance(999);
    assert.deepEqual(suspended, []);
    advance(1);
    assert.deepEqual(suspended, ["w1"]);
  });

  it("leaving IDLE cancels the timer", () => {
    const { idle, suspended, advance, pendingCount } = build();
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    advance(500);
    idle.onWorkerChange({ workerId: "w1", state: "WORKING" });
    advance(5000);
    assert.deepEqual(suspended, []);
    assert.equal(pendingCount(), 0);
  });

  it("a new IDLE edge restarts the full period", () => {
    const { idle, suspended, advance } = build();
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    advance(800);
    idle.onWorkerChange({ workerId: "w1", state: "WORKING" });
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    advance(800);
    assert.deepEqual(suspended, []);
    advance(200);
    assert.deepEqual(suspended, ["w1"]);
  });

  it("ignores stateless nudges", () => {
    const { idle, suspended, advance } = build();
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    advance(500);
    idle.onWorkerChange({ workerId: "w1" });
    advance(500);
    assert.deepEqual(suspended, ["w1"]);
  });

  it("a worker that must stay live is checked again after another period", () => {
    let keep: string | null = "subagents running";
    const { idle, suspended, advance } = build({ keepReason: () => keep });
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    advance(1000);
    assert.deepEqual(suspended, []);
    keep = null;
    advance(1000);
    assert.deepEqual(suspended, ["w1"]);
  });

  it("dispose cancels every timer", () => {
    const { idle, suspended, advance, pendingCount } = build();
    idle.onWorkerChange({ workerId: "w1", state: "IDLE" });
    idle.onWorkerChange({ workerId: "w2", state: "IDLE" });
    idle.dispose();
    advance(5000);
    assert.deepEqual(suspended, []);
    assert.equal(pendingCount(), 0);
  });
});
