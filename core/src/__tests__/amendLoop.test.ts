import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { amendLoop, type AmendLoopDeps, type AmendLoopInput } from "../use-cases/amendLoop.ts";
import { ConflictError, NotFoundError, PermissionDeniedError, ValidationError } from "../errors/index.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { LoopRow, LoopAmendPatch } from "../ports/LoopStateRepo.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";

const GOAL: GoalSpec = { summary: "v2", criteria: [{ id: "c1", text: "npm test green", verify: "npm test" }] };

const armed = (deps: AmendLoopDeps, input: Omit<AmendLoopInput, "enabled"> & { enabled?: boolean }) =>
  amendLoop(deps, { enabled: true, ...input });

const loopRow = (over: Partial<LoopRow> = {}): LoopRow =>
  ({ id: "l-1", workerId: "o-1", status: "active", goal: GOAL, strategy: "hybrid", ...over } as LoopRow);

function buildDeps(
  rows: Record<string, Partial<WorkerRow>>,
  loops: { byId?: Record<string, LoopRow>; active?: Record<string, LoopRow> } = {},
): { deps: AmendLoopDeps; amended: Array<{ id: string; patch: LoopAmendPatch }>; resets: string[] } {
  const amended: Array<{ id: string; patch: LoopAmendPatch }> = [];
  const resets: string[] = [];
  const loopsRepo = {
    findById: (id: string) => loops.byId?.[id] ?? null,
    findActiveByWorker: (workerId: string) => loops.active?.[workerId] ?? null,
    amend: (id: string, patch: LoopAmendPatch) => { amended.push({ id, patch }); },
    resetProgress: (id: string) => { resets.push(id); },
  } as unknown as AmendLoopDeps["loops"];
  const workers = {
    findById: (id: string) => (rows[id] ? ({ id, ...rows[id] } as WorkerRow) : null),
  } as unknown as AmendLoopDeps["workers"];
  return { deps: { loops: loopsRepo, workers }, amended, resets };
}

describe("amendLoop", () => {
  it("refuses when the feature is disabled", () => {
    const { deps, amended } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow() } });
    assert.throws(
      () => amendLoop(deps, { callerId: "o-1", goal: GOAL, enabled: false }),
      (e: unknown) => e instanceof ValidationError && /dynamic loop is disabled/.test((e as Error).message),
    );
    assert.equal(amended.length, 0);
  });

  it("self-loop by target: replaces goal/strategy/limit and clears the ring", () => {
    const { deps, amended, resets } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow() } });
    const res = armed(deps, { callerId: "o-1", goal: GOAL, strategy: "command", limit: 5 });
    assert.deepEqual(res, { loopId: "l-1", status: "active" });
    assert.deepEqual(amended, [{ id: "l-1", patch: { goal: GOAL, strategy: "command", maxAttempts: 5 } }]);
    assert.deepEqual(resets, ["l-1"]);
  });

  it("resolves the loop by loopId when given", () => {
    const { deps, amended } = buildDeps(
      { "o-1": { is_orchestrator: 1 } },
      { byId: { "l-7": loopRow({ id: "l-7" }) } },
    );
    armed(deps, { callerId: "o-1", loopId: "l-7", strategy: "judge" });
    assert.equal(amended[0].id, "l-7");
  });

  it("only provided fields land in the patch; absent fields are omitted", () => {
    const { deps, amended, resets } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow() } });
    armed(deps, { callerId: "o-1", limit: 3 });
    assert.deepEqual(amended[0].patch, { maxAttempts: 3 });
    // goal untouched → ring is NOT cleared.
    assert.deepEqual(resets, []);
  });

  it("an explicit null limit is passed through as unbounded (key present)", () => {
    const { deps, amended } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow() } });
    armed(deps, { callerId: "o-1", limit: null });
    assert.ok("maxAttempts" in amended[0].patch);
    assert.equal(amended[0].patch.maxAttempts, null);
  });

  it("worker target: amends the owned worker's active loop", () => {
    const { deps, amended } = buildDeps(
      { "o-1": { is_orchestrator: 1 }, "w-9": { parent_id: "o-1" } },
      { active: { "w-9": loopRow({ id: "l-9", workerId: "w-9" }) } },
    );
    armed(deps, { callerId: "o-1", target: "w-9", goal: GOAL });
    assert.equal(amended[0].id, "l-9");
  });

  it("rejects a non-active loop", () => {
    const { deps } = buildDeps(
      { "o-1": { is_orchestrator: 1 } },
      { byId: { "l-1": loopRow({ status: "passed" }) } },
    );
    assert.throws(() => armed(deps, { callerId: "o-1", loopId: "l-1", limit: 2 }), ConflictError);
  });

  it("rejects a loop on a target the caller does not own", () => {
    const { deps } = buildDeps(
      { "o-1": { is_orchestrator: 1 }, "w-other": { parent_id: "o-2" } },
      { active: { "w-other": loopRow({ workerId: "w-other" }) } },
    );
    assert.throws(() => armed(deps, { callerId: "o-1", target: "w-other", limit: 2 }), PermissionDeniedError);
  });

  it("rejects a non-orchestrator caller", () => {
    const { deps } = buildDeps({ "w-1": { is_orchestrator: 0 } }, { active: { "w-1": loopRow({ workerId: "w-1" }) } });
    assert.throws(() => armed(deps, { callerId: "w-1", limit: 2 }), PermissionDeniedError);
  });

  it("throws NotFound when the caller does not exist", () => {
    const { deps } = buildDeps({});
    assert.throws(() => armed(deps, { callerId: "o-ghost", limit: 2 }), NotFoundError);
  });

  it("throws NotFound when no active loop resolves", () => {
    const { deps } = buildDeps({ "o-1": { is_orchestrator: 1 } });
    assert.throws(() => armed(deps, { callerId: "o-1", limit: 2 }), NotFoundError);
  });

  // Carry-over: amend runs the SAME criteria lint attach does, so a goal can't be
  // renegotiated into a structurally-unpassable shape attach would have rejected.
  it("rejects a command-strategy amend that smuggles in a verify-less criterion", () => {
    const { deps, amended } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow({ strategy: "command" }) } });
    const bad: GoalSpec = { summary: "v3", criteria: [{ id: "c1", text: "game is fun" }] }; // no verify
    assert.throws(() => armed(deps, { callerId: "o-1", goal: bad, strategy: "command" }), ValidationError);
    assert.equal(amended.length, 0); // nothing written on a rejected amend
  });

  it("rejects switching an existing verify-less goal to the command strategy (lint reads the effective goal)", () => {
    const vfless: GoalSpec = { summary: "v", criteria: [{ id: "c1", text: "subjective" }] };
    const { deps } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow({ goal: vfless, strategy: "judge" }) } });
    assert.throws(() => armed(deps, { callerId: "o-1", strategy: "command" }), ValidationError);
  });

  it("surfaces a warning (not a rejection) for a judge goal whose criterion is verify-less and names no file", () => {
    const { deps, amended } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow({ strategy: "judge" }) } });
    const soft: GoalSpec = { summary: "v", criteria: [{ id: "c1", text: "the game feels fun" }] };
    const res = armed(deps, { callerId: "o-1", goal: soft });
    assert.equal(res.status, "active");
    assert.ok(res.warnings && res.warnings.length === 1);
    assert.match(res.warnings[0], /has no verify and names no file path/);
    assert.equal(amended.length, 1); // a warning does not block the amend
  });

  it("no lint when neither goal nor strategy is amended (limit-only amend never warns)", () => {
    const vfless: GoalSpec = { summary: "v", criteria: [{ id: "c1", text: "subjective" }] };
    const { deps } = buildDeps({ "o-1": { is_orchestrator: 1 } }, { active: { "o-1": loopRow({ goal: vfless, strategy: "judge" }) } });
    const res = armed(deps, { callerId: "o-1", limit: 4 });
    assert.equal(res.warnings, undefined);
  });
});
