import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reportHoldGate } from "../report-hold.ts";
import type { LoopStateRepo, LoopRow } from "../../../core/src/ports/LoopStateRepo.ts";

function fakeLoops(active: LoopRow | null) {
  const heldCalls: Array<{ id: string; text: string | null }> = [];
  const loops = {
    findActiveByWorker: () => active,
    setHeldReport: (id: string, text: string | null) => { heldCalls.push({ id, text }); },
  } as unknown as Pick<LoopStateRepo, "findActiveByWorker" | "setHeldReport">;
  return { loops, heldCalls };
}

const LOOP = { id: "l-1", workerId: "w-1" } as LoopRow;

describe("reportHoldGate", () => {
  it("HOLDS a result: report under an active loop (held_report set, parent not dispatched)", () => {
    const { loops, heldCalls } = fakeLoops(LOOP);
    assert.deepEqual(reportHoldGate(loops, "w-1", "result: shipped"), { held: true });
    assert.deepEqual(heldCalls, [{ id: "l-1", text: "result: shipped" }]);
  });

  it("PASSES a needs input: report immediately even with an active loop (no hold)", () => {
    const { loops, heldCalls } = fakeLoops(LOOP);
    assert.deepEqual(reportHoldGate(loops, "w-1", "needs input: which one?"), { held: false });
    assert.equal(heldCalls.length, 0);
  });

  it("PASSES failed: by default; HOLDS failed: only when retryOnFailed", () => {
    const a = fakeLoops(LOOP);
    assert.deepEqual(reportHoldGate(a.loops, "w-1", "failed: blocked"), { held: false });
    assert.equal(a.heldCalls.length, 0);

    const b = fakeLoops(LOOP);
    assert.deepEqual(reportHoldGate(b.loops, "w-1", "failed: blocked", { retryOnFailed: true }), { held: true });
    assert.deepEqual(b.heldCalls, [{ id: "l-1", text: "failed: blocked" }]);
  });

  it("HOLDS an unknown first line under an active loop", () => {
    const { loops } = fakeLoops(LOOP);
    assert.deepEqual(reportHoldGate(loops, "w-1", "I think I'm done here"), { held: true });
  });

  it("PASSES everything when there is no active loop", () => {
    const { loops, heldCalls } = fakeLoops(null);
    assert.deepEqual(reportHoldGate(loops, "w-1", "result: shipped"), { held: false });
    assert.equal(heldCalls.length, 0);
  });
});
