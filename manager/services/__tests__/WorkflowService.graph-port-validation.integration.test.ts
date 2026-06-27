import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkflowService, type WorkflowServiceDeps } from "../WorkflowService.ts";
import { buildEngine, spawnPort, type SpawnResponse } from "../../../core/src/__tests__/helpers/workflowFakes.ts";
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import type { WorkflowRun, WorkflowRunStatus } from "../../../contracts/src/workflow.ts";
import type { WorkflowRunResult } from "../../../core/src/ports/WorkflowEngine.ts";

// Regression for DEVIATION D1: a v2-graph `json` input port carrying a JSON-Schema
// must be validated AT RUNTIME on the WIRED path. The isolated attachGraphPortValidators
// unit test (json-schema-validator.test.ts) passed while the wired path was broken —
// WorkflowService.run never applied the validator to a v2 graph, so a schema-violating
// value flowed in and the run reported PASSED on the scheduler's coarse object check.
// These tests drive a v2 graph THROUGH WorkflowService.run end-to-end (NO manual
// attachGraphPortValidators), proving the acceptance point now compiles the schema.

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

function ids() {
  let n = 0;
  const mk = () => `id-${++n}`;
  return { newWorkerId: mk, newOrchestratorId: mk, newPendingId: mk, newRequestId: mk, newLoopId: mk };
}

// A v2 graph whose consumer declares a typed `json` input port (schema: {a} required).
// The producer's output is delivered over an edge to that port — the one place the
// scheduler validates a port value. The schema is a PLAIN JSON-Schema object: only the
// wired acceptance path can turn it into the live safeParse the scheduler consumes.
const graph = (): WorkflowGraph => ({
  name: "typed-json-port-wired", version: WORKFLOW_GRAPH_VERSION,
  nodes: [
    { id: "in", kind: "input" },
    { id: "producer", kind: "worker", config: { prompt: "p" }, outputs: [{ name: "out", type: "json" }] },
    { id: "consumer", kind: "worker", config: { prompt: "c {{in.payload}}" },
      inputs: [{ name: "payload", type: "json", schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } }] },
    { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
  ],
  edges: [
    { from: { node: "in", port: "out" }, to: { node: "producer", port: "in" } },
    { from: { node: "producer", port: "out" }, to: { node: "consumer", port: "payload" } },
    { from: { node: "consumer", port: "out" }, to: { node: "out", port: "in" } },
  ],
});

// Wire WorkflowService against the REAL engine + REAL built-in executors (only the
// spawn boundary faked). deliverCompletion resolves `done` with the terminal result,
// so the fire-and-forget run is awaitable.
function harness(producerOutput: unknown) {
  const spawn = spawnPort((spec): SpawnResponse => (spec.nodeId === "producer" ? { output: producerOutput } : {}));
  const { engine } = buildEngine(spawn);

  let resolveDone!: (_r: WorkflowRunResult) => void;
  const done = new Promise<WorkflowRunResult>((r) => { resolveDone = r; });

  const runs = new Map<string, WorkflowRun>();
  const deps: WorkflowServiceDeps = {
    engine,
    runs: {
      insert(row) { runs.set(row.id, row); },
      findById(id) { return runs.get(id) ?? null; },
      listActive() { return []; },
      listByOwner() { return []; },
      setStatus(id, status: WorkflowRunStatus) { const r = runs.get(id); if (r) r.status = status; },
      setResult(id, result) { const r = runs.get(id); if (r) r.result = result; },
    },
    spawn: { spawnAndAwait: async () => { throw new Error("unused"); }, spawnExpert: async () => ({ workerId: "x" }), killWorker() {}, mintRunAnchor: (r) => r },
    progress: { runChanged() {}, stepChanged() {} },
    definitions: { create() {}, listFor: () => [], deleteForOwner() {} },
    resolveDefinition: () => null,
    resolveMode: () => "acceptEdits",
    deliverCompletion: (_ownerId, result) => resolveDone(result),
    ids: ids(),
    log: noopLog,
  };
  return { svc: new WorkflowService(deps), spawn, done };
}

describe("WorkflowService.run — v2 graph json port validation (wired path, D1)", () => {
  it("FAILS the run when a json input port value violates its schema (no manual validator)", async () => {
    // {b:"x"} is an object (passes the coarse isObject fallback) but is missing the
    // required field `a` — only a compiled schema validator catches it. A run reported
    // PASSED here would be the exact D1 silent-false-success.
    const { svc, spawn, done } = harness({ b: "x" });
    svc.run({ spec: graph(), args: {} }, "orch-1");
    const result = await done;

    assert.equal(result.status, "failed", "schema-violating json port value must FAIL the run");
    assert.match(String(result.output), /input port "payload" failed schema validation/);
    assert.ok(!spawn.calls.steps.some((s) => s.nodeId === "consumer"), "the mis-shaped node never spawned");
  });

  it("PASSES the run when the json input port value matches its schema", async () => {
    const { svc, spawn, done } = harness({ a: 1 });
    svc.run({ spec: graph(), args: {} }, "orch-1");
    const result = await done;

    assert.equal(result.status, "passed", "schema-valid json port value passes");
    assert.ok(spawn.calls.steps.some((s) => s.nodeId === "consumer"), "the validated node ran");
  });
});
