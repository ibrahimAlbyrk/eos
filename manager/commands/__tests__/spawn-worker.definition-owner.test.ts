import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnWorkerHandler } from "../handlers/spawn-worker.ts";
import type { WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

// §ITEM 4 — a workflow step/expert spawns under the synthetic run anchor (its
// parentId is the anchor id, NOT the orchestrator selfId). The handler must
// resolve the orchestrator's create_worker runtime defs by the RUN OWNER, threaded
// in as `definitionOwnerId`, falling back to parentId for the normal spawn path.
//
// These tests exercise the REAL handler up to (and only to) the definition-
// resolution gate: a SENTINEL thrown by c.userSettings.read() (the first container
// access AFTER a successful resolve) marks "resolution passed". An unresolved
// definition throws "unknown worker definition" BEFORE that gate — so the two
// outcomes cleanly distinguish a resolved def from an invisible one without
// standing up the full spawn machinery.

const REACHED_SPAWN_PREP = "REACHED_SPAWN_PREP";

const runtimeDef = (name: string): WorkerDefinitionRecord =>
  ({ name, description: "", whenToUse: "", body: "", source: "runtime" }) as WorkerDefinitionRecord;

function fakeContainer(runtimeDefsByOwner: Record<string, WorkerDefinitionRecord[]>) {
  const listForCalls: string[] = [];
  const c = {
    listWorkerDefinitionRecords: () => [],
    runtimeWorkerDefinitions: {
      listFor: (owner: string) => {
        listForCalls.push(owner);
        return runtimeDefsByOwner[owner] ?? [];
      },
    },
    // First container access after a successful resolve (resolveSpawnIsolation) —
    // throwing here proves the definition resolved without running the real spawn.
    userSettings: { read: () => { throw new Error(REACHED_SPAWN_PREP); } },
  };
  return { c, listForCalls };
}

const callHandler = (c: unknown, body: Record<string, unknown>) =>
  spawnWorkerHandler.run({}, body as never, { c, requestId: "test" } as never);

describe("spawnWorkerHandler — runtime worker-definition owner resolution (§ITEM 4)", () => {
  it("workflow step: resolves a runtime def owned by definitionOwnerId even when parentId is the anchor", async () => {
    const { c, listForCalls } = fakeContainer({ "orch-1": [runtimeDef("wf-spec")] });
    await assert.rejects(
      callHandler(c, { prompt: "go", worktreeFrom: "/repo", from: "wf-spec", parentId: "anchor-1", definitionOwnerId: "orch-1" }),
      new RegExp(REACHED_SPAWN_PREP),
    );
    assert.ok(listForCalls.includes("orch-1"), "runtime defs queried by the run owner, not the anchor");
  });

  it("normal spawn (definitionOwnerId unset): unchanged — resolves runtime defs by parentId", async () => {
    const { c, listForCalls } = fakeContainer({ "orch-1": [runtimeDef("wf-spec")] });
    await assert.rejects(
      callHandler(c, { prompt: "go", worktreeFrom: "/repo", from: "wf-spec", parentId: "orch-1" }),
      new RegExp(REACHED_SPAWN_PREP),
    );
    assert.deepEqual(listForCalls, ["orch-1"]);
  });

  it("regression: without the fix the anchor-owned lookup misses the def (unknown worker definition)", async () => {
    const { c, listForCalls } = fakeContainer({ "orch-1": [runtimeDef("wf-spec")] });
    await assert.rejects(
      callHandler(c, { prompt: "go", worktreeFrom: "/repo", from: "wf-spec", parentId: "anchor-1" }),
      /unknown worker definition: wf-spec/,
    );
    assert.deepEqual(listForCalls, ["anchor-1"]); // queried the anchor → empty → invisible
  });
});
