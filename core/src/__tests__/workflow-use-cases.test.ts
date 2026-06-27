import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../use-cases/RunWorkflow.ts";
import { resumeWorkflow } from "../use-cases/ResumeWorkflow.ts";
import { createWorkflowDefinition } from "../use-cases/CreateWorkflowDefinition.ts";
import { stopWorkflow } from "../use-cases/StopWorkflow.ts";
import { runRepo, progressSink } from "./helpers/workflowFakes.ts";
import type { WorkflowEngine, WorkflowRunResult, RunContext } from "../ports/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";

const def: WorkflowDefinition = { name: "d", root: { type: "step", id: "s", prompt: "p" } };

function fakeEngine() {
  const calls = { run: [] as Array<{ def: WorkflowDefinition; args: unknown; ctx: RunContext }>, resume: [] as string[] };
  const engine: WorkflowEngine = {
    run(d, args, ctx) {
      calls.run.push({ def: d, args, ctx });
      return Promise.resolve({ runId: ctx.runId, status: "passed", output: "out" } as WorkflowRunResult);
    },
    resume(runId, _ctx) {
      calls.resume.push(runId);
      return Promise.resolve({ runId, status: "passed", output: null } as WorkflowRunResult);
    },
    runNode() { return Promise.resolve({ output: undefined, status: "passed" }); },
    journalFailedNode() {},
  };
  return { engine, calls };
}

describe("runWorkflow", () => {
  it("runs an inline spec through engine.run", async () => {
    const { engine, calls } = fakeEngine();
    const res = await runWorkflow({ engine }, { runId: "r1", ownerId: "o", mode: "acceptEdits", spec: def, args: { x: 1 } });
    assert.deepEqual(res, { runId: "r1", status: "passed", output: "out" });
    assert.equal(calls.run[0].def, def);
    assert.deepEqual(calls.run[0].ctx, { runId: "r1", ownerId: "o", mode: "acceptEdits", signal: undefined });
  });

  it("resolves a stored `from` name via the overlay resolver", async () => {
    const { engine, calls } = fakeEngine();
    await runWorkflow(
      { engine, resolveDefinition: (n, o) => (n === "known" && o === "o" ? def : null) },
      { runId: "r2", ownerId: "o", mode: "default", from: "known" },
    );
    assert.equal(calls.run[0].def, def);
  });

  it("throws when the definition cannot be resolved", async () => {
    const { engine } = fakeEngine();
    await assert.rejects(
      () => runWorkflow({ engine }, { runId: "r3", ownerId: "o", mode: "default", from: "ghost" }),
      /workflow definition not found: ghost/,
    );
  });
});

describe("resumeWorkflow", () => {
  it("delegates to engine.resume", async () => {
    const { engine, calls } = fakeEngine();
    const res = await resumeWorkflow({ engine }, { runId: "r9", ownerId: "o", mode: "default" });
    assert.equal(res.runId, "r9");
    assert.deepEqual(calls.resume, ["r9"]);
  });
});

describe("createWorkflowDefinition", () => {
  it("validates and persists a per-owner runtime definition", () => {
    const stored: Array<{ owner: string; name: string }> = [];
    const store = {
      create(owner: string, d: WorkflowDefinition) { stored.push({ owner, name: d.name }); },
      listFor() { return []; },
      deleteForOwner() {},
    };
    const res = createWorkflowDefinition({ store }, { ownerId: "o", spec: def });
    assert.deepEqual(res, { name: "d" });
    assert.deepEqual(stored, [{ owner: "o", name: "d" }]);
  });

  it("rejects a malformed spec at the boundary", () => {
    const store = { create() {}, listFor() { return []; }, deleteForOwner() {} };
    assert.throws(() => createWorkflowDefinition({ store }, { ownerId: "o", spec: { name: "x" } as unknown as WorkflowDefinition }));
  });

  it("rejects a spec with duplicate node ids, naming the duplicated id, and does not persist", () => {
    const stored: string[] = [];
    const store = { create(_o: string, d: WorkflowDefinition) { stored.push(d.name); }, listFor() { return []; }, deleteForOwner() {} };
    // The duplicate sits one level deeper (inside a forEach body) than the first
    // occurrence — proving the walk descends the full tree, not just top children.
    const dupeSpec: WorkflowDefinition = {
      name: "dupes",
      root: { type: "parallel", id: "root", children: [
        { type: "step", id: "dup", prompt: "p" },
        { type: "forEach", id: "loop", over: "{{args.items}}", body: { type: "step", id: "dup", prompt: "q" } },
      ] },
    };
    assert.throws(() => createWorkflowDefinition({ store }, { ownerId: "o", spec: dupeSpec }), /duplicate node id.*\bdup\b/i);
    assert.deepEqual(stored, [], "a duplicate-id definition is never persisted");
  });
});

describe("stopWorkflow", () => {
  it("transitions a running run to stopped, fires the abort callback, and publishes", () => {
    const runs = runRepo();
    runs.insert({ id: "r", definitionName: "d", owner: "o", anchorId: "r", status: "running", startedAt: 1, updatedAt: 1 });
    const progress = progressSink();
    let aborted = false;
    const res = stopWorkflow({ runs, progress }, { runId: "r", abort: () => { aborted = true; } });

    assert.deepEqual(res, { runId: "r", status: "stopped" });
    assert.equal(runs.findById("r")!.status, "stopped");
    assert.equal(aborted, true);
    assert.deepEqual(progress.runs.at(-1), { runId: "r", status: "stopped" });
  });

  it("is idempotent on a terminal run (no abort, no publish)", () => {
    const runs = runRepo();
    runs.insert({ id: "done", definitionName: "d", owner: "o", anchorId: "done", status: "passed", startedAt: 1, updatedAt: 1 });
    const progress = progressSink();
    let aborted = false;
    const res = stopWorkflow({ runs, progress }, { runId: "done", abort: () => { aborted = true; } });
    assert.equal(res.status, "passed");
    assert.equal(aborted, false);
    assert.equal(progress.runs.length, 0);
  });

  it("throws for an unknown run", () => {
    const runs = runRepo();
    const progress = progressSink();
    assert.throws(() => stopWorkflow({ runs, progress }, { runId: "missing" }), /workflow run not found: missing/);
  });
});
