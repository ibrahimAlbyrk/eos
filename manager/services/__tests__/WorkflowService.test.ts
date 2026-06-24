import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkflowService } from "../WorkflowService.ts";
import type { WorkflowServiceDeps } from "../WorkflowService.ts";
import type { WorkflowDefinition, WorkflowRun, WorkflowRunStatus } from "../../../contracts/src/workflow.ts";
import type { RunContext, WorkflowRunResult } from "../../../core/src/ports/WorkflowEngine.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

function ids() {
  let n = 0;
  const mk = () => `id-${++n}`;
  return { newWorkerId: mk, newOrchestratorId: mk, newPendingId: mk, newRequestId: mk, newLoopId: mk };
}

// Records what the engine/use-cases were asked to do, without driving anything.
function harness(over: Partial<WorkflowServiceDeps> = {}) {
  const runs = new Map<string, WorkflowRun>();
  const calls = {
    run: [] as Array<{ def: WorkflowDefinition; args: unknown; ctx: RunContext }>,
    resume: [] as Array<{ runId: string; ctx: RunContext }>,
    killed: [] as string[],
    created: [] as Array<{ ownerId: string; spec: WorkflowDefinition }>,
    progress: [] as Array<{ runId: string; status: WorkflowRunStatus }>,
  };
  const engine = {
    async run(def: WorkflowDefinition, args: unknown, ctx: RunContext): Promise<WorkflowRunResult> {
      calls.run.push({ def, args, ctx });
      // Mirror the real engine's synchronous prefix: insert the run row so a
      // follow-up status() resolves.
      runs.set(ctx.runId, {
        id: ctx.runId, definitionName: def.name, owner: ctx.ownerId, anchorId: ctx.runId,
        status: "running", args, startedAt: 1, updatedAt: 1,
      });
      return { runId: ctx.runId, status: "passed", output: "ok" };
    },
    async resume(runId: string, ctx: RunContext): Promise<WorkflowRunResult> {
      calls.resume.push({ runId, ctx });
      return { runId, status: "passed", output: "ok" };
    },
    async runNode() { throw new Error("unused"); },
  };
  const deps: WorkflowServiceDeps = {
    engine: engine as never,
    runs: {
      insert(row) { runs.set(row.id, row); },
      findById(id) { return runs.get(id) ?? null; },
      listActive() { return [...runs.values()].filter((r) => r.status === "running" || r.status === "pending"); },
      listByOwner(o) { return [...runs.values()].filter((r) => r.owner === o); },
      setStatus(id, status) { const r = runs.get(id); if (r) r.status = status; },
      setResult(id, result) { const r = runs.get(id); if (r) r.result = result; },
    },
    spawn: { spawnAndAwait: async () => { throw new Error("unused"); }, spawnExpert: async () => ({ workerId: "x" }), killWorker: (id) => calls.killed.push(id), mintRunAnchor: (r) => r },
    progress: { runChanged: (runId, status) => calls.progress.push({ runId, status }), stepChanged() {} },
    definitions: { create: (ownerId, spec) => calls.created.push({ ownerId, spec }), listFor: () => [], deleteForOwner() {} },
    resolveDefinition: (name) => (name === "known" ? { name: "known", root: { id: "r", type: "step", from: "x", prompt: "p" } } as never : null),
    resolveMode: () => "acceptEdits",
    ids: ids(),
    log: noopLog,
    ...over,
  };
  return { svc: new WorkflowService(deps), deps, calls, runs };
}

describe("WorkflowService", () => {
  it("run-stored: resolves the definition and drives engine.run with owner+mode", async () => {
    const { svc, calls } = harness();
    const res = svc.run({ from: "known", args: { x: 1 } }, "orch-1");
    assert.equal(res.status, "running");
    assert.ok(res.runId);
    await Promise.resolve(); // let the fire-and-forget engine.run microtask run
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].def.name, "known");
    assert.deepEqual(calls.run[0].args, { x: 1 });
    assert.equal(calls.run[0].ctx.ownerId, "orch-1");
    assert.equal(calls.run[0].ctx.mode, "acceptEdits");
    assert.ok(calls.run[0].ctx.signal instanceof AbortSignal);
  });

  it("run-stored: an unknown definition throws NotFoundError before any drive", () => {
    const { svc, calls } = harness();
    assert.throws(() => svc.run({ from: "nope" }, "orch-1"), /not found/i);
    assert.equal(calls.run.length, 0);
  });

  it("run-inline: validates the spec and drives the engine", async () => {
    const { svc, calls } = harness();
    const spec = { name: "inline", root: { id: "r", type: "step", from: "x", prompt: "p" } } as unknown as WorkflowDefinition;
    svc.run({ spec, args: { a: 2 } }, "orch-2");
    await Promise.resolve();
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].def.name, "inline");
  });

  it("run with neither from nor spec throws", () => {
    const { svc } = harness();
    assert.throws(() => svc.run({}, "orch-1"), /from.*spec/i);
  });

  it("status reads the run row", async () => {
    const { svc } = harness();
    const { runId } = svc.run({ from: "known" }, "orch-1");
    await Promise.resolve();
    const st = svc.status(runId);
    assert.equal(st.runId, runId);
    assert.equal(st.status, "running");
  });

  it("stop sets stopped, aborts the signal, and reaps the anchor subtree", async () => {
    const { svc, calls, runs } = harness();
    const { runId } = svc.run({ from: "known" }, "orch-1");
    await Promise.resolve();
    const signal = calls.run[0].ctx.signal!;
    const res = svc.stop(runId);
    assert.equal(res.status, "stopped");
    assert.equal(runs.get(runId)!.status, "stopped");
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls.killed, [runId]); // anchorId === runId
    assert.ok(calls.progress.some((p) => p.runId === runId && p.status === "stopped"));
  });

  it("resume reconstructs the context from the run row and drives engine.resume", async () => {
    const { svc, deps, calls } = harness();
    deps.runs.insert({ id: "run-x", definitionName: "known", owner: "orch-9", anchorId: "run-x", status: "running", startedAt: 1, updatedAt: 1 });
    await svc.resume("run-x");
    assert.equal(calls.resume.length, 1);
    assert.equal(calls.resume[0].runId, "run-x");
    assert.equal(calls.resume[0].ctx.ownerId, "orch-9");
    assert.equal(calls.resume[0].ctx.mode, "acceptEdits");
  });

  it("create persists a per-owner runtime definition", () => {
    const { svc, calls } = harness();
    const spec = { name: "wf-1", root: { id: "r", type: "step", from: "x", prompt: "p" } } as unknown as WorkflowDefinition;
    const res = svc.create(spec, "orch-3");
    assert.deepEqual(res, { name: "wf-1" });
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].ownerId, "orch-3");
  });
});
