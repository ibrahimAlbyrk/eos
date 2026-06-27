import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngineImpl, type WorkflowEngineDeps } from "../workflow/engine.ts";
import { InMemoryStepExecutorRegistry } from "../workflow/registry.ts";
import { wf } from "../workflow/dsl.ts";
import type { StepExecutor, NodeResult } from "../ports/StepExecutor.ts";
import type { SpawnStepSpec, StepOutcome, ExpertSpawnSpec } from "../ports/WorkerSpawnPort.ts";
import type { WorkflowRun, WorkflowStep, WorkflowRunStatus, StepStatus } from "../../../contracts/src/workflow.ts";
import type { StepNode, SequenceNode } from "../../../contracts/src/workflow-node.ts";

// --- fakes (no real spawn, no SQLite, deterministic clock/ids) ----------------

function fakeClock() {
  let t = 1000;
  return { now: () => t++ };
}

function fakeIds() {
  let n = 0;
  const mk = () => `id-${++n}`;
  return { newWorkerId: mk, newOrchestratorId: mk, newPendingId: mk, newRequestId: mk, newLoopId: mk };
}

const noopLog = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLog; },
};

function runRepo() {
  const rows = new Map<string, WorkflowRun>();
  return {
    rows,
    insert(row: WorkflowRun) { rows.set(row.id, { ...row }); },
    findById(id: string) { return rows.get(id) ?? null; },
    listActive() { return [...rows.values()].filter((r) => r.status === "pending" || r.status === "running"); },
    listByOwner(ownerId: string) { return [...rows.values()].filter((r) => r.owner === ownerId); },
    setStatus(id: string, status: WorkflowRunStatus) { const r = rows.get(id); if (r) r.status = status; },
    setResult(id: string, result: unknown) { const r = rows.get(id); if (r) r.result = result; },
  };
}

function stepRepo() {
  const rows = new Map<string, WorkflowStep>();
  const key = (runId: string, nodeId: string) => `${runId}:${nodeId}`;
  return {
    rows,
    upsert(row: WorkflowStep) { rows.set(key(row.runId, row.nodeId), { ...row }); },
    listByRun(runId: string) { return [...rows.values()].filter((r) => r.runId === runId); },
    findByNode(runId: string, nodeId: string) { return rows.get(key(runId, nodeId)) ?? null; },
    setStatus(runId: string, nodeId: string, status: StepStatus) { const r = rows.get(key(runId, nodeId)); if (r) r.status = status; },
    setOutput(runId: string, nodeId: string, output: unknown) { const r = rows.get(key(runId, nodeId)); if (r) r.output = output; },
    setWorker(runId: string, nodeId: string, workerId: string) { const r = rows.get(key(runId, nodeId)); if (r) r.workerId = workerId; },
  };
}

function spawnPort() {
  const calls = {
    anchors: [] as Array<{ runId: string; ownerId: string; mode: string }>,
    experts: [] as ExpertSpawnSpec[],
    steps: [] as SpawnStepSpec[],
    killed: [] as string[],
  };
  let w = 0;
  return {
    calls,
    mintRunAnchor(runId: string, ownerId: string, mode: string) {
      calls.anchors.push({ runId, ownerId, mode });
      return runId; // anchor row id = runId (§3.5)
    },
    async spawnExpert(spec: ExpertSpawnSpec) {
      calls.experts.push(spec);
      return { workerId: `expert-${++w}` };
    },
    async spawnAndAwait(spec: SpawnStepSpec, _signal: AbortSignal): Promise<StepOutcome> {
      calls.steps.push(spec);
      const workerId = `step-w-${++w}`;
      // echo the (already binding-resolved) prompt as the emitted output
      return { workerId, status: "done", output: spec.prompt };
    },
    killWorker(workerId: string) { calls.killed.push(workerId); },
  };
}

function progressSink() {
  const runs: Array<{ runId: string; status: WorkflowRunStatus }> = [];
  const steps: Array<{ nodeId: string; status: StepStatus }> = [];
  return {
    runs, steps,
    runChanged(runId: string, status: WorkflowRunStatus) { runs.push({ runId, status }); },
    stepChanged(_runId: string, nodeId: string, status: StepStatus) { steps.push({ nodeId, status }); },
  };
}

// A fake leaf `step` executor that exercises the real wiring: it resolves its
// prompt from bindings and spawns through the concurrency gate.
const stepExecutor: StepExecutor = {
  type: "step",
  async execute(node, ctx): Promise<NodeResult> {
    const s = node as StepNode;
    const prompt = ctx.bindings.resolve(s.prompt);
    const outcome = await ctx.concurrency.run(() => ctx.spawn.spawnAndAwait({
      runId: ctx.runId, nodeId: s.id, parentId: ctx.anchorId, from: s.from, prompt,
      mode: ctx.mode, collaborate: false, outputSchema: s.outputSchema,
    }, ctx.signal));
    return { output: outcome.output, status: "passed", childWorkerIds: [outcome.workerId] };
  },
};

// A fake `sequence` composite that recurses through the engine seam (ctx.engine).
const sequenceExecutor: StepExecutor = {
  type: "sequence",
  async execute(node, ctx): Promise<NodeResult> {
    const seq = node as SequenceNode;
    const childWorkerIds: string[] = [];
    let last: NodeResult = { output: undefined, status: "passed" };
    for (const child of seq.children) {
      last = await ctx.engine.runNode(child, ctx);
      if (last.childWorkerIds) childWorkerIds.push(...last.childWorkerIds);
    }
    return { output: last.output, status: "passed", childWorkerIds };
  },
};

function buildDeps(over: Partial<WorkflowEngineDeps> = {}) {
  const reg = new InMemoryStepExecutorRegistry();
  reg.register(stepExecutor);
  reg.register(sequenceExecutor);
  const deps: WorkflowEngineDeps = {
    registry: reg,
    runs: runRepo(),
    steps: stepRepo(),
    spawn: spawnPort(),
    progress: progressSink(),
    clock: fakeClock(),
    ids: fakeIds(),
    log: noopLog,
    maxConcurrentSteps: 4,
    ...over,
  };
  return deps;
}

const demo = wf.define("demo", (b) => ({
  root: b.sequence([
    b.step({ id: "plan", from: "planner", prompt: "P {{args.x}}" }),
    b.step({ id: "impl", from: "impl", prompt: "I {{nodes.plan.output}}" }),
  ], "root"),
}));

describe("WorkflowEngine.run — lifecycle", () => {
  it("mints the anchor, inserts the run, walks the tree, persists, and tears down", async () => {
    const deps = buildDeps();
    const engine = new WorkflowEngineImpl(deps);
    const res = await engine.run(demo, { x: "hi" }, { runId: "run-1", ownerId: "orch-1", mode: "acceptEdits" });

    assert.deepEqual(res, { runId: "run-1", status: "passed", output: "I P hi" });

    const spawn = deps.spawn as ReturnType<typeof spawnPort>;
    assert.deepEqual(spawn.calls.anchors, [{ runId: "run-1", ownerId: "orch-1", mode: "acceptEdits" }]);
    // every step spawned under the anchor, with mode set explicitly + no peer mesh
    assert.equal(spawn.calls.steps.length, 2);
    assert.ok(spawn.calls.steps.every((s) => s.parentId === "run-1" && s.mode === "acceptEdits" && s.collaborate === false));
    // bindings flowed: impl saw plan's output
    assert.equal(spawn.calls.steps[1].prompt, "I P hi");
    // teardown guaranteed exactly once on the anchor
    assert.deepEqual(spawn.calls.killed, ["run-1"]);

    const runs = deps.runs as ReturnType<typeof runRepo>;
    const row = runs.findById("run-1")!;
    assert.equal(row.status, "passed");
    assert.equal(row.result, "I P hi");
    assert.equal(row.anchorId, "run-1");
    assert.equal(row.startedAt, 1000); // clock port, not Date.now

    // each WORKER node journaled passed. Under the graph runtime the "root" sequence
    // is lowered to ordering edges (it is no longer a node), so only the leaf workers
    // journal — observably equivalent: plan + impl both ran, passed, output threaded.
    const steps = deps.steps as ReturnType<typeof stepRepo>;
    const byNode = new Map(steps.listByRun("run-1").map((s) => [s.nodeId, s.status]));
    assert.deepEqual([byNode.get("plan"), byNode.get("impl")], ["passed", "passed"]);
  });

  it("spawns the standing experts (persistent + collaborate) under the anchor before any step", async () => {
    const withExperts = wf.define("demo-x", (b) => ({
      experts: [{ id: "solid-expert", from: "solid-expert", prompt: "be the SOLID authority" }],
      root: b.sequence([b.step({ id: "only", prompt: "go" })], "root"),
    }));
    const deps = buildDeps();
    const engine = new WorkflowEngineImpl(deps);
    await engine.run(withExperts, {}, { runId: "run-x", ownerId: "orch-1", mode: "default" });

    const spawn = deps.spawn as ReturnType<typeof spawnPort>;
    assert.equal(spawn.calls.experts.length, 1);
    const e = spawn.calls.experts[0];
    assert.equal(e.name, "solid-expert");
    assert.equal(e.parentId, "run-x");
    assert.equal(e.persistent, true);
    assert.equal(e.collaborate, true);
    assert.deepEqual(spawn.calls.killed, ["run-x"]); // experts reaped via the anchor
  });

  it("still tears the anchor down when an executor throws (finally guarantee)", async () => {
    const reg = new InMemoryStepExecutorRegistry();
    reg.register({ type: "step", async execute() { throw new Error("step blew up"); } } as StepExecutor);
    reg.register(sequenceExecutor);
    const deps = buildDeps({ registry: reg });
    const engine = new WorkflowEngineImpl(deps);

    await assert.rejects(
      engine.run(demo, { x: "hi" }, { runId: "run-err", ownerId: "orch-1", mode: "default" }),
      /step blew up/,
    );
    const spawn = deps.spawn as ReturnType<typeof spawnPort>;
    assert.deepEqual(spawn.calls.killed, ["run-err"]);
  });
});

describe("WorkflowEngine — memoized replay (resume)", () => {
  it("replays a whole journaled-passed root without re-spawning", async () => {
    const deps = buildDeps({ resolveDefinition: () => demo });
    const runs = deps.runs as ReturnType<typeof runRepo>;
    const steps = deps.steps as ReturnType<typeof stepRepo>;
    runs.insert({
      id: "run-2", definitionName: "demo", owner: "orch-1", anchorId: "run-2",
      status: "running", args: { x: "hi" }, startedAt: 1, updatedAt: 1,
    });
    // The whole run already completed: every WORKER node journaled passed. (Under
    // graph scheduling the "root" sequence is ordering edges, not a node, so the
    // journaled frontier is the leaf workers; replaying them re-spawns nothing and
    // the OUTPUT node still resolves to the last node's output.)
    steps.upsert({
      id: "run-2:plan", runId: "run-2", nodeId: "plan", nodeType: "step",
      status: "passed", workerId: null, output: "P hi", startedAt: 1, endedAt: 2,
    });
    steps.upsert({
      id: "run-2:impl", runId: "run-2", nodeId: "impl", nodeType: "step",
      status: "passed", workerId: null, output: { done: true }, startedAt: 1, endedAt: 2,
    });

    const engine = new WorkflowEngineImpl(deps);
    const res = await engine.resume("run-2", { runId: "run-2", ownerId: "orch-1", mode: "default" });

    assert.deepEqual(res, { runId: "run-2", status: "passed", output: { done: true } });
    const spawn = deps.spawn as ReturnType<typeof spawnPort>;
    assert.equal(spawn.calls.steps.length, 0, "no step re-spawned — memoized");
    assert.deepEqual(spawn.calls.killed, ["run-2"]); // teardown still runs
  });

  it("replays only the journaled step and re-runs the rest", async () => {
    const deps = buildDeps({ resolveDefinition: () => demo });
    const runs = deps.runs as ReturnType<typeof runRepo>;
    const steps = deps.steps as ReturnType<typeof stepRepo>;
    runs.insert({
      id: "run-3", definitionName: "demo", owner: "orch-1", anchorId: "run-3",
      status: "running", args: { x: "hi" }, startedAt: 1, updatedAt: 1,
    });
    // plan already done; root + impl are not journaled → must re-run
    steps.upsert({
      id: "run-3:plan", runId: "run-3", nodeId: "plan", nodeType: "step",
      status: "passed", workerId: "old-w", output: "P cached", startedAt: 1, endedAt: 2,
    });

    const engine = new WorkflowEngineImpl(deps);
    const res = await engine.resume("run-3", { runId: "run-3", ownerId: "orch-1", mode: "default" });

    const spawn = deps.spawn as ReturnType<typeof spawnPort>;
    assert.equal(spawn.calls.steps.length, 1, "only impl re-spawned; plan replayed from journal");
    assert.equal(spawn.calls.steps[0].prompt, "I P cached"); // impl saw plan's journaled output
    assert.equal(res.status, "passed");
  });

  it("rejects resume of an unknown or inline run", async () => {
    const deps = buildDeps({ resolveDefinition: () => demo });
    const engine = new WorkflowEngineImpl(deps);
    await assert.rejects(engine.resume("missing", { runId: "missing", ownerId: "o", mode: "default" }), /not found/);

    const runs = deps.runs as ReturnType<typeof runRepo>;
    runs.insert({ id: "inline-1", definitionName: null, owner: "o", anchorId: "inline-1", status: "running", startedAt: 1, updatedAt: 1 });
    await assert.rejects(engine.resume("inline-1", { runId: "inline-1", ownerId: "o", mode: "default" }), /inline/);
  });
});
