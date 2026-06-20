import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { armLoopAtSpawn, type ArmLoopAtSpawnDeps } from "../arm-loop-at-spawn.ts";
import type { InsertLoopInput } from "../../../core/src/ports/LoopStateRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { SpawnLoop } from "../../../contracts/src/loop.ts";

const GOAL = { summary: "done", criteria: [{ id: "c1", text: "tests pass", verify: "npm test" }] };

function build(loopConfig: ArmLoopAtSpawnDeps["loopConfig"]) {
  const inserted: InsertLoopInput[] = [];
  const published: Array<{ workerId: string; status: string }> = [];
  const rows: Record<string, Partial<WorkerRow>> = { "o-1": { is_orchestrator: 1 }, "w-new": { parent_id: "o-1" } };
  const deps = {
    loops: { insert: (i: InsertLoopInput) => inserted.push(i), findActiveByWorker: () => null },
    workers: { findById: (id: string) => (rows[id] ? ({ id, ...rows[id] } as WorkerRow) : null) },
    ids: { newLoopId: () => "l-1" },
    clock: { now: () => 1000 },
    bus: { publish: (_t: string, p: { workerId: string; status: string }) => published.push(p) },
    loopConfig,
  } as unknown as ArmLoopAtSpawnDeps;
  return { deps, inserted, published };
}

describe("armLoopAtSpawn", () => {
  it("inserts an active loop for the NEW worker (parent = caller, config defaults) + publishes loop:change{active}", () => {
    const { deps, inserted, published } = build({ enabled: true, strategy: "hybrid", maxAttempts: null });
    armLoopAtSpawn(deps, { parentId: "o-1", workerId: "w-new", loop: { goal: GOAL } as SpawnLoop });
    assert.equal(inserted.length, 1);                  // loop row exists BEFORE the first turn
    assert.equal(inserted[0].workerId, "w-new");
    assert.equal(inserted[0].parentId, "o-1");
    assert.equal(inserted[0].strategy, "hybrid");      // config default
    assert.equal(inserted[0].maxAttempts, null);       // config default → UNBOUNDED
    assert.deepEqual(published, [{ workerId: "w-new", status: "active" }]);
  });

  it("per-loop strategy + limit override the config defaults", () => {
    const { deps, inserted } = build({ enabled: true, strategy: "hybrid", maxAttempts: null });
    armLoopAtSpawn(deps, { parentId: "o-1", workerId: "w-new", loop: { goal: GOAL, strategy: "command", limit: 7 } as SpawnLoop });
    assert.equal(inserted[0].strategy, "command");
    assert.equal(inserted[0].maxAttempts, 7);
  });
});
