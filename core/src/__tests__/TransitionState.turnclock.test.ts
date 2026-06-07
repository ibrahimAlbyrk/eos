import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transitionState, type TransitionStateDeps } from "../use-cases/TransitionState.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";

const NOW = 1_000_000;

function makeDeps(state: WorkerState) {
  const row = { id: "w1", state, turn_started_at: null as number | null };
  const stamps: number[] = [];
  const deps = {
    workers: {
      findById: () => row as unknown as WorkerRow,
      updateState: (_id: string, next: WorkerState) => { row.state = next; },
      setTurnStartedAt: (_id: string, ts: number) => { row.turn_started_at = ts; stamps.push(ts); },
    },
    events: { append: () => 1 },
    bus: { publish: () => {} },
    clock: { now: () => NOW },
  } as unknown as TransitionStateDeps;
  return { row, stamps, deps };
}

describe("transitionState turn clock", () => {
  it("stamps turn_started_at on IDLE → WORKING", () => {
    const { row, stamps, deps } = makeDeps("IDLE");
    assert.equal(transitionState(deps, { workerId: "w1", next: "WORKING", reason: "user_message" }), "applied");
    assert.deepEqual(stamps, [NOW]);
    assert.equal(row.turn_started_at, NOW);
  });

  it("does not restamp on busy-internal SPAWNING → WORKING", () => {
    const { stamps, deps } = makeDeps("SPAWNING");
    assert.equal(transitionState(deps, { workerId: "w1", next: "WORKING", reason: "first_event" }), "applied");
    assert.deepEqual(stamps, []);
  });

  it("does not stamp on WORKING → IDLE (turn end)", () => {
    const { stamps, deps } = makeDeps("WORKING");
    assert.equal(transitionState(deps, { workerId: "w1", next: "IDLE", reason: "stop_hook" }), "applied");
    assert.deepEqual(stamps, []);
  });

  it("does not stamp on rejected transitions", () => {
    const { stamps, deps } = makeDeps("DONE");
    assert.equal(transitionState(deps, { workerId: "w1", next: "WORKING", reason: "late_event" }), "rejected");
    assert.deepEqual(stamps, []);
  });
});
