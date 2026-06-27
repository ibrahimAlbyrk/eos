import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reArmWorkflows } from "../workflow-rearm.ts";
import { wf } from "../../../core/src/workflow/dsl.ts";
import {
  buildEngine, spawnPort, runRepo, stepRepo, noopLog,
} from "../../../core/src/__tests__/helpers/workflowFakes.ts";
import type { WorkflowRunResult } from "../../../core/src/ports/WorkflowEngine.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";
import type { QueuedMessage } from "../../../core/src/ports/MessageQueueRepo.ts";

// Empty durable sources — the default for runs with nothing to recover.
const noEvents = { list: (): WorkerEventRow[] => [] };
const noQueue = { listPending: (): QueuedMessage[] => [] };

describe("reArmWorkflows", () => {
  it("resumes every active run and isolates a failing one", async () => {
    const resumed: string[] = [];
    const runs = { listActive: () => [{ id: "a" }, { id: "b" }, { id: "c" }] };
    await reArmWorkflows({
      runs: runs as never,
      steps: { listByRun: () => [], setStatus() {}, setOutput() {} },
      events: noEvents,
      queue: noQueue,
      resume: async (id) => { resumed.push(id); if (id === "b") throw new Error("boom"); },
      log: noopLog,
    });
    assert.deepEqual([...resumed].sort(), ["a", "b", "c"]);
  });

  it("replays a seeded journal through engine.resume WITHOUT re-spawning the done step", async () => {
    const runs = runRepo();
    const steps = stepRepo();
    const spawn = spawnPort();
    const def = wf.define("wf", (b) => ({
      root: b.sequence([
        b.step({ id: "n1", from: "a", prompt: "p1" }),
        b.step({ id: "n2", from: "b", prompt: "p2" }),
      ], "root"),
    }));
    // An interrupted run: n1 already finished (journaled passed), n2 never ran.
    runs.insert({
      id: "run-1", definitionName: "wf", owner: "orch", anchorId: "run-1",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    steps.upsert({
      id: "run-1:n1", runId: "run-1", nodeId: "n1", nodeType: "step",
      status: "passed", workerId: "w-old", output: "done-1", startedAt: 1, endedAt: 2,
    });

    const { engine } = buildEngine(spawn, {
      runs, steps,
      resolveDefinition: (name) => (name === "wf" ? def : null),
    });

    await reArmWorkflows({
      runs, steps, events: noEvents, queue: noQueue,
      resume: (runId): Promise<WorkflowRunResult> =>
        engine.resume(runId, { runId, ownerId: "orch", mode: "acceptEdits" }),
      log: noopLog,
    });

    const spawnedNodeIds = spawn.calls.steps.map((s) => s.nodeId);
    assert.deepEqual(spawnedNodeIds, ["n2"], "only the un-journaled node n2 re-spawns; n1 replays from its journal");
    assert.equal(runs.rows.get("run-1")!.status, "passed");
    assert.equal(steps.rows.get("run-1:n2")!.status, "passed");
  });

  it("recovers an unjournaled completion from a durable worker_report event (no re-spawn)", async () => {
    const runs = runRepo();
    const steps = stepRepo();
    const spawn = spawnPort();
    const def = wf.define("solo", (b) => ({
      root: b.step({ id: "n1", from: "a", prompt: "p1" }),
    }));
    // The crash window: n1's worker finished and reported, but the `passed` journal
    // write was lost — the row is stuck `running` with its stamped worker id (w-7).
    runs.insert({
      id: "run-x", definitionName: "solo", owner: "orch", anchorId: "anchor-x",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    steps.upsert({
      id: "run-x:n1", runId: "run-x", nodeId: "n1", nodeType: "step",
      status: "running", workerId: "w-7", startedAt: 1, endedAt: null,
    });
    // The durable trace: a parent-timeline worker_report under the anchor whose
    // payload.fromWorker is the stuck step worker.
    const events = {
      list: (): WorkerEventRow[] => [{
        id: 1, worker_id: "anchor-x", ts: 2, type: "worker_report",
        payload: JSON.stringify({ text: "recovered-output", fromWorker: "w-7", workerName: "n1" }),
      }],
    };

    const { engine } = buildEngine(spawn, {
      runs, steps,
      resolveDefinition: (name) => (name === "solo" ? def : null),
    });

    await reArmWorkflows({
      runs, steps, events, queue: noQueue,
      resume: (runId): Promise<WorkflowRunResult> =>
        engine.resume(runId, { runId, ownerId: "orch", mode: "acceptEdits" }),
      log: noopLog,
    });

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), [], "the recovered step is NOT re-spawned");
    assert.equal(steps.rows.get("run-x:n1")!.status, "passed");
    assert.equal(steps.rows.get("run-x:n1")!.output, "recovered-output");
    assert.equal(runs.rows.get("run-x")!.status, "passed");
  });

  it("recovers an unjournaled step from the structured workflow_step_output trace (no re-spawn, typed object)", async () => {
    const runs = runRepo();
    const steps = stepRepo();
    const spawn = spawnPort();
    const def = wf.define("solo-s", (b) => ({
      root: b.step({ id: "n1", from: "a", prompt: "p1" }),
    }));
    // The crash window: n1's worker emitted its typed output via /step-output (so
    // the route stamped the structured trace under the anchor) but the engine's
    // `passed` journal write was lost — the row is stuck `running` with worker w-5.
    runs.insert({
      id: "run-s", definitionName: "solo-s", owner: "orch", anchorId: "anchor-s",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    steps.upsert({
      id: "run-s:n1", runId: "run-s", nodeId: "n1", nodeType: "step",
      status: "running", workerId: "w-5", startedAt: 1, endedAt: null,
    });
    const structuredOutput = { files: ["a.ts", "b.ts"], count: 2 };
    const events = {
      list: (): WorkerEventRow[] => [{
        id: 1, worker_id: "anchor-s", ts: 2, type: "workflow_step_output",
        payload: JSON.stringify({ fromWorker: "w-5", status: "done", output: structuredOutput }),
      }],
    };

    const { engine } = buildEngine(spawn, {
      runs, steps,
      resolveDefinition: (name) => (name === "solo-s" ? def : null),
    });

    await reArmWorkflows({
      runs, steps, events, queue: noQueue,
      resume: (runId): Promise<WorkflowRunResult> =>
        engine.resume(runId, { runId, ownerId: "orch", mode: "acceptEdits" }),
      log: noopLog,
    });

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), [], "the recovered step is NOT re-spawned");
    assert.equal(steps.rows.get("run-s:n1")!.status, "passed");
    // The recovered output is the STRUCTURED object, not a stringified body.
    assert.deepEqual(steps.rows.get("run-s:n1")!.output, structuredOutput);
    assert.deepEqual(runs.rows.get("run-s")!.result, structuredOutput);
    assert.equal(runs.rows.get("run-s")!.status, "passed");
  });

  it("a failed structured trace is re-journaled failed (reason as output), not falsely passed", async () => {
    const runs = runRepo();
    const steps = stepRepo();
    const spawn = spawnPort();
    runs.insert({
      id: "run-f", definitionName: "solo-f", owner: "orch", anchorId: "anchor-f",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    steps.upsert({
      id: "run-f:n1", runId: "run-f", nodeId: "n1", nodeType: "step",
      status: "running", workerId: "w-6", startedAt: 1, endedAt: null,
    });
    const events = {
      list: (): WorkerEventRow[] => [{
        id: 1, worker_id: "anchor-f", ts: 2, type: "workflow_step_output",
        payload: JSON.stringify({ fromWorker: "w-6", status: "failed", reason: "could not build" }),
      }],
    };

    // A no-op resume isolates the recovery write — a failed step is NOT memo-
    // replayable (the engine re-runs non-passed nodes on a real resume), so we
    // assert only that recovery re-journals it faithfully rather than false-passing.
    await reArmWorkflows({
      runs, steps, events, queue: noQueue,
      resume: async () => ({}),
      log: noopLog,
    });

    assert.equal(steps.rows.get("run-f:n1")!.status, "failed");
    assert.equal(steps.rows.get("run-f:n1")!.output, "could not build");
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), []);
  });

  it("recovers an unjournaled completion from a durable queued worker_report envelope", async () => {
    const runs = runRepo();
    const steps = stepRepo();
    const spawn = spawnPort();
    const def = wf.define("solo-q", (b) => ({
      root: b.step({ id: "n1", from: "a", prompt: "p1" }),
    }));
    runs.insert({
      id: "run-q", definitionName: "solo-q", owner: "orch", anchorId: "anchor-q",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    steps.upsert({
      id: "run-q:n1", runId: "run-q", nodeId: "n1", nodeType: "step",
      status: "running", workerId: "w-9", startedAt: 1, endedAt: null,
    });
    // Events empty; the report holds only in the agent-plane queue (anchor never drains).
    const queue = {
      listPending: (workerId: string): QueuedMessage[] =>
        workerId === "anchor-q"
          ? [{
              id: 1, workerId: "anchor-q", clientMsgId: "m1", text: "[wrapper] queued-output",
              displayText: "queued-output", createdAt: 2,
              envelope: { kind: "worker_report", fromWorker: "w-9", workerName: "n1" },
            }]
          : [],
    };

    const { engine } = buildEngine(spawn, {
      runs, steps,
      resolveDefinition: (name) => (name === "solo-q" ? def : null),
    });

    await reArmWorkflows({
      runs, steps, events: noEvents, queue,
      resume: (runId): Promise<WorkflowRunResult> =>
        engine.resume(runId, { runId, ownerId: "orch", mode: "acceptEdits" }),
      log: noopLog,
    });

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), [], "the recovered step is NOT re-spawned");
    assert.equal(steps.rows.get("run-q:n1")!.status, "passed");
    assert.equal(steps.rows.get("run-q:n1")!.output, "queued-output");
  });
});
