import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reArmLoops, stopLoopForExitedWorker, type ReArmLoopsDeps } from "../loop-rearm.ts";
import type { LoopRow } from "../../../core/src/ports/LoopStateRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const loop = (id: string, workerId: string): LoopRow => ({ id, workerId } as LoopRow);

function build(active: LoopRow[], workers: Record<string, WorkerRow | undefined>, over: Partial<ReArmLoopsDeps> = {}) {
  const resumed: string[] = [];
  const ticked: string[] = [];
  const deps: ReArmLoopsDeps = {
    loops: { listActive: () => active },
    workers: { findById: (id: string) => workers[id] ?? null } as ReArmLoopsDeps["workers"],
    resume: async (w: WorkerRow) => { resumed.push(w.id); },
    loopTickFor: (id: string) => { ticked.push(id); },
    log: noopLog,
    ...over,
  };
  return { deps, resumed, ticked };
}

describe("reArmLoops", () => {
  it("revives + kicks each active loop whose worker still exists", async () => {
    const { deps, resumed, ticked } = build(
      [loop("l-1", "w-1"), loop("l-2", "w-2")],
      { "w-1": { id: "w-1" } as WorkerRow, "w-2": { id: "w-2" } as WorkerRow },
    );
    await reArmLoops(deps);
    assert.deepEqual(resumed, ["w-1", "w-2"]);
    assert.deepEqual(ticked, ["w-1", "w-2"]);
  });

  it("skips a loop whose worker no longer exists", async () => {
    const { deps, resumed, ticked } = build([loop("l-1", "gone")], {});
    await reArmLoops(deps);
    assert.equal(resumed.length, 0);
    assert.equal(ticked.length, 0);
  });

  it("a failing revive is logged and does not abort the rest", async () => {
    const { deps, ticked } = build(
      [loop("l-1", "w-1"), loop("l-2", "w-2")],
      { "w-1": { id: "w-1" } as WorkerRow, "w-2": { id: "w-2" } as WorkerRow },
      { resume: async (w: WorkerRow) => { if (w.id === "w-1") throw new Error("revive failed"); } },
    );
    await reArmLoops(deps);
    assert.deepEqual(ticked, ["w-2"]);   // w-1's failure didn't stop w-2
  });
});

describe("stopLoopForExitedWorker", () => {
  function loopsWith(active: LoopRow | null) {
    const statuses: Array<{ id: string; status: string }> = [];
    const published: Array<{ workerId: string; status: string }> = [];
    const deps = {
      loops: { findActiveByWorker: () => active, setStatus: (id: string, status: string) => { statuses.push({ id, status }); } },
      bus: { publish: (_t: string, payload: { workerId: string; status: string }) => { published.push(payload); } },
    };
    return { deps, statuses, published };
  }

  it("stops an exited worker's active loop and publishes loop:change{stopped}", () => {
    const { deps, statuses, published } = loopsWith(loop("l-1", "w-1"));
    stopLoopForExitedWorker(deps as never, "w-1");
    assert.deepEqual(statuses, [{ id: "l-1", status: "stopped" }]);
    assert.deepEqual(published, [{ workerId: "w-1", status: "stopped" }]);
  });

  it("no-ops when the exited worker had no active loop", () => {
    const { deps, statuses, published } = loopsWith(null);
    stopLoopForExitedWorker(deps as never, "w-1");
    assert.equal(statuses.length, 0);
    assert.equal(published.length, 0);
  });
});
