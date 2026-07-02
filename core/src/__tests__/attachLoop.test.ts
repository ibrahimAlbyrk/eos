import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachLoop, type AttachLoopDeps, type AttachLoopInput } from "../use-cases/attachLoop.ts";
import { ConflictError, NotFoundError, PermissionDeniedError, ValidationError } from "../errors/index.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { InsertLoopInput, LoopRow } from "../ports/LoopStateRepo.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";

const NOW = 1_700_000_000_000;
const GOAL: GoalSpec = { summary: "tests pass", criteria: [{ id: "c1", text: "npm test green", verify: "npm test" }] };

// The kill-switch is on by default for these tests; the disabled case overrides it.
const armed = (deps: AttachLoopDeps, input: Omit<AttachLoopInput, "enabled"> & { enabled?: boolean }): { loopId: string } =>
  attachLoop(deps, { enabled: true, ...input });

function buildDeps(
  rows: Record<string, Partial<WorkerRow>>,
  active: Record<string, boolean> = {},
): { deps: AttachLoopDeps; inserted: InsertLoopInput[] } {
  const inserted: InsertLoopInput[] = [];
  const loops = {
    insert: (input: InsertLoopInput) => { inserted.push(input); },
    findActiveByWorker: (workerId: string) => (active[workerId] ? ({ id: "l-existing" } as LoopRow) : null),
  } as unknown as AttachLoopDeps["loops"];
  const workers = {
    findById: (id: string) => (rows[id] ? ({ id, ...rows[id] } as WorkerRow) : null),
  } as unknown as AttachLoopDeps["workers"];
  const deps: AttachLoopDeps = {
    loops,
    workers,
    ids: { newLoopId: () => "l-fixed" },
    clock: { now: () => NOW },
  };
  return { deps, inserted };
}

describe("attachLoop", () => {
  it("refuses to attach when the feature is disabled (config.loop.enabled=false)", () => {
    const { deps, inserted } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    assert.throws(
      () => attachLoop(deps, { callerId: "o-1", goal: GOAL, enabled: false }),
      (e: unknown) => e instanceof ValidationError && /dynamic loop is disabled/.test((e as Error).message),
    );
    assert.equal(inserted.length, 0);
  });

  it("allows attach when enabled", () => {
    const { deps, inserted } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    armed(deps, { callerId: "o-1", goal: GOAL });
    assert.equal(inserted.length, 1);
  });

  it("self-loop: inserts an active loop with null parent and default strategy", () => {
    const { deps, inserted } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    const res = armed(deps, { callerId: "o-1", goal: GOAL });
    assert.equal(res.loopId, "l-fixed");
    assert.deepEqual(inserted, [{
      id: "l-fixed", workerId: "o-1", parentId: null, goal: GOAL,
      strategy: "hybrid", maxAttempts: null, startedAt: NOW, updatedAt: NOW,
    }]);
  });

  it("worker target: parent is the owning orchestrator; strategy + limit are honored", () => {
    const { deps, inserted } = buildDeps({
      "o-1": { is_orchestrator: 1 },
      "w-9": { parent_id: "o-1" },
    });
    armed(deps, { callerId: "o-1", target: "w-9", goal: GOAL, strategy: "command", limit: 5 });
    assert.equal(inserted[0].workerId, "w-9");
    assert.equal(inserted[0].parentId, "o-1");
    assert.equal(inserted[0].strategy, "command");
    assert.equal(inserted[0].maxAttempts, 5);
  });

  it("refuses a second active loop on the same target", () => {
    const { deps } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { "o-1": true });
    assert.throws(() => armed(deps, { callerId: "o-1", goal: GOAL }), ConflictError);
  });

  it("rejects a target the caller does not own", () => {
    const { deps } = buildDeps({
      "o-1": { is_orchestrator: 1 },
      "w-other": { parent_id: "o-2" },
    });
    assert.throws(() => armed(deps, { callerId: "o-1", target: "w-other", goal: GOAL }), PermissionDeniedError);
  });

  it("rejects a non-orchestrator caller", () => {
    const { deps } = buildDeps({ "w-1": { is_orchestrator: 0 } });
    assert.throws(() => armed(deps, { callerId: "w-1", goal: GOAL }), PermissionDeniedError);
  });

  it("throws NotFound when the caller does not exist", () => {
    const { deps } = buildDeps({});
    assert.throws(() => armed(deps, { callerId: "o-ghost", goal: GOAL }), NotFoundError);
  });
});

describe("attachLoop goal lint", () => {
  const NO_VERIFY: GoalSpec = { summary: "playable", criteria: [{ id: "c1", text: "the game is playable" }] };

  it("rejects a command-strategy goal with a verify-less criterion (structurally unpassable)", () => {
    const { deps, inserted } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    assert.throws(
      () => armed(deps, { callerId: "o-1", goal: NO_VERIFY, strategy: "command" }),
      (e: unknown) => e instanceof ValidationError && /verify/.test((e as Error).message),
    );
    assert.equal(inserted.length, 0);
  });

  it("warns (not rejects) on a judge/hybrid verify-less criterion that names no file path", () => {
    const { deps, inserted } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    const res = attachLoop(deps, { callerId: "o-1", goal: NO_VERIFY, strategy: "hybrid", enabled: true });
    assert.equal(inserted.length, 1);                 // attach still succeeds
    assert.equal(res.warnings?.length, 1);
    assert.match(res.warnings![0], /c1/);
  });

  it("no warning when a verify-less criterion names a file path", () => {
    const goal: GoalSpec = { summary: "compiles", criteria: [{ id: "c1", text: "src/game.ts compiles" }] };
    const { deps } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    const res = attachLoop(deps, { callerId: "o-1", goal, strategy: "judge", enabled: true });
    assert.equal(res.warnings, undefined);
  });

  it("warns only for the verify-less criterion in a mixed goal", () => {
    const goal: GoalSpec = {
      summary: "mixed",
      criteria: [
        { id: "c1", text: "npm test green", verify: "npm test" },
        { id: "c2", text: "the ui feels responsive" },
      ],
    };
    const { deps } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    const res = attachLoop(deps, { callerId: "o-1", goal, strategy: "hybrid", enabled: true });
    assert.equal(res.warnings?.length, 1);
    assert.match(res.warnings![0], /c2/);
  });
});
