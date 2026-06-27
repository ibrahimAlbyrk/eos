import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildEngine, spawnPort, tick, type SpawnResponse } from "./helpers/workflowFakes.ts";
import { WorkflowGraphSchema, WORKFLOW_GRAPH_VERSION, type WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import type { RunContext } from "../ports/WorkflowEngine.ts";

// Phase 2 proof tests: the readiness scheduler executed against HAND-AUTHORED v2
// graphs (engine.run takes a v2 graph directly — no tree compile in between), so
// these pin the graph-native behaviours the tree runtime never had: branch
// skip-propagation draining an unreachable sub-region, an encapsulated loop node
// re-scheduling its body per iteration, deterministic fan-in by edge order, and a
// mid-graph resume that continues from the un-journaled frontier.

const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };
const echoNodeId = (spec: { nodeId: string }): SpawnResponse => ({ output: spec.nodeId });

// Assert a hand-authored graph is a structurally-valid v2 graph before running it,
// so these tests exercise the scheduler on graphs the contract would accept.
function valid(g: WorkflowGraph): WorkflowGraph {
  const parsed = WorkflowGraphSchema.safeParse(g);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  return g;
}

// ===========================================================================
// BRANCH SKIP-PROPAGATION
// ===========================================================================

describe("graph scheduler — branch skip-propagation", () => {
  // input → branch → { then: T } | { else: E1 → E2 } → merge → output.
  // The unchosen arm (a multi-node sub-region) must be drained as `skipped`: its
  // nodes neither run nor block the merge, and the merge still re-converges.
  const graph = (): WorkflowGraph => valid({
    name: "branch-skip",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "br", kind: "branch", config: { predicate: { op: "eq", left: "{{args.flag}}", right: "go" } },
        outputs: [{ name: "then", type: "any" }, { name: "else", type: "any" }] },
      { id: "T", kind: "worker", config: { prompt: "T" } },
      { id: "E1", kind: "worker", config: { prompt: "E1" } },
      { id: "E2", kind: "worker", config: { prompt: "E2 {{nodes.E1.output}}" } },
      { id: "m", kind: "merge", outputs: [{ name: "out", type: "any" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "br", port: "in" } },
      { from: { node: "br", port: "then" }, to: { node: "T", port: "in" } },
      { from: { node: "br", port: "else" }, to: { node: "E1", port: "in" } },
      { from: { node: "E1", port: "out" }, to: { node: "E2", port: "in" } },
      { from: { node: "T", port: "out" }, to: { node: "m", port: "in" } },
      { from: { node: "E2", port: "out" }, to: { node: "m", port: "in" } },
      { from: { node: "m", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("runs the then arm and drains the entire else sub-region (E1, E2 skipped) — merge still resolves", async () => {
    const spawn = spawnPort(echoNodeId);
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(graph(), { flag: "go" }, CTX);

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["T"], "only the then arm ran");
    assert.equal(res.status, "passed");
    assert.equal(res.output, "T", "merge re-converged to the then arm's output");
    // the skipped sub-region was never journaled (neither ran)
    assert.equal(deps.steps.findByNode("run", "E1"), null);
    assert.equal(deps.steps.findByNode("run", "E2"), null);
  });

  it("runs the multi-node else sub-region and skips the then arm when the predicate fails", async () => {
    const spawn = spawnPort(echoNodeId);
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(graph(), { flag: "stop" }, CTX);

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["E1", "E2"], "the whole else chain ran in order");
    const e2 = spawn.calls.steps.find((s) => s.nodeId === "E2")!;
    assert.equal(e2.prompt, "E2 E1", "E2 saw E1's output (the else chain threaded)");
    assert.equal(res.output, "E2", "merge re-converged to the else arm's output");
    assert.equal(deps.steps.findByNode("run", "T"), null, "the then arm was skipped");
  });
});

// ===========================================================================
// ENCAPSULATED LOOP NODE
// ===========================================================================

describe("graph scheduler — encapsulated loop node iterates its body sub-graph", () => {
  // A single `loop` node (forEach) whose config.body is its own v2 sub-graph; the
  // scheduler re-schedules that sub-graph once per runtime item, scoping ids so the
  // journal rows never collide.
  const body: WorkflowGraph = {
    name: "loop-body",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "__input__", kind: "input", outputs: [{ name: "out", type: "any" }] },
      { id: "w", kind: "worker", config: { prompt: "item {{item}} #{{index}}" } },
      { id: "__output__", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "__input__", port: "out" }, to: { node: "w", port: "in" } },
      { from: { node: "w", port: "out" }, to: { node: "__output__", port: "in" } },
    ],
  };
  const graph = (): WorkflowGraph => valid({
    name: "loop",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "L", kind: "loop", config: { loopKind: "forEach", over: "{{args.items}}", body }, outputs: [{ name: "out", type: "array" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "L", port: "in" } },
      { from: { node: "L", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("fans one body run per item, scoping ids, injecting item/index, aggregating outputs in order", async () => {
    const spawn = spawnPort(echoNodeId);
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(graph(), { items: ["x", "y", "z"] }, CTX);

    // one scoped body worker per runtime item — ids isolated so journal rows differ
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["w#0", "w#1", "w#2"]);
    assert.deepEqual(spawn.calls.steps.map((s) => s.prompt), ["item x #0", "item y #1", "item z #2"]);
    assert.deepEqual(res.output, ["w#0", "w#1", "w#2"], "per-iteration outputs aggregated in item order");
    assert.equal(res.status, "passed");
    assert.ok(deps.steps.findByNode("run", "w#0") && deps.steps.findByNode("run", "w#2"));
    assert.equal(deps.steps.findByNode("run", "w"), null, "the unscoped body id never journals");
  });
});

// ===========================================================================
// DETERMINISTIC FAN-IN ORDER
// ===========================================================================

describe("graph scheduler — fan-in resolves in edge-declaration order, not completion order", () => {
  // Three workers fan into one array merge. The merge's incoming edges are declared
  // [wA, wB, wC], but the workers are made to COMPLETE in the order wB, wC, wA. The
  // aggregate must still be [wA, wB, wC] — edge order, deterministic by construction.
  const graph = (): WorkflowGraph => valid({
    name: "fan-in",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "wA", kind: "worker", config: { prompt: "A" } },
      { id: "wB", kind: "worker", config: { prompt: "B" } },
      { id: "wC", kind: "worker", config: { prompt: "C" } },
      { id: "m", kind: "merge", outputs: [{ name: "out", type: "array" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "wA", port: "in" } },
      { from: { node: "in", port: "out" }, to: { node: "wB", port: "in" } },
      { from: { node: "in", port: "out" }, to: { node: "wC", port: "in" } },
      { from: { node: "wA", port: "out" }, to: { node: "m", port: "in" } },
      { from: { node: "wB", port: "out" }, to: { node: "m", port: "in" } },
      { from: { node: "wC", port: "out" }, to: { node: "m", port: "in" } },
      { from: { node: "m", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("aggregates by edge order even when completion order is scrambled", async () => {
    const delays: Record<string, number> = { wA: 30, wB: 5, wC: 15 }; // completion: wB, wC, wA
    const spawn = spawnPort(async (spec): Promise<SpawnResponse> => {
      await new Promise((r) => setTimeout(r, delays[spec.nodeId] ?? 0));
      return { output: spec.nodeId };
    });
    const { engine } = buildEngine(spawn);
    const res = await engine.run(graph(), {}, CTX);

    assert.deepEqual(res.output, ["wA", "wB", "wC"], "edge-declaration order, independent of completion timing");
    assert.equal(res.status, "passed");
  });
});

// ===========================================================================
// MID-GRAPH RESUME FROM THE FRONTIER
// ===========================================================================

describe("graph scheduler — resume continues from the un-journaled frontier", () => {
  // input → A → B → C → output. A and B are journaled `passed`; resume must replay
  // them from the journal (no re-spawn) and run only C, threading B's journaled
  // output into C's prompt.
  const graph: WorkflowGraph = {
    name: "chain",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "A" } },
      { id: "B", kind: "worker", config: { prompt: "B {{nodes.A.output}}" } },
      { id: "C", kind: "worker", config: { prompt: "C {{nodes.B.output}}" } },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "A", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "A" } },
      { from: { node: "B", port: "out" }, to: { node: "C", port: "in" } },
      { from: { node: "B", port: "out" }, to: { node: "C", port: "B" } },
      { from: { node: "C", port: "out" }, to: { node: "out", port: "in" } },
    ],
  };

  it("replays journaled A + B and runs only the frontier node C", async () => {
    const spawn = spawnPort(echoNodeId);
    const { engine, deps } = buildEngine(spawn, {
      resolveDefinition: (name: string) => (name === "chain" ? (graph as never) : null),
    });
    // An interrupted run: A and B already journaled passed, C never ran.
    deps.runs.insert({
      id: "run", definitionName: "chain", owner: "orch", anchorId: "run",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    deps.steps.upsert({
      id: "run:A", runId: "run", nodeId: "A", nodeType: "worker",
      status: "passed", workerId: "wA-old", output: "A-done", startedAt: 1, endedAt: 2,
    });
    deps.steps.upsert({
      id: "run:B", runId: "run", nodeId: "B", nodeType: "worker",
      status: "passed", workerId: "wB-old", output: "B-done", startedAt: 1, endedAt: 2,
    });

    const res = await engine.resume("run", CTX);

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["C"], "only the frontier node re-spawns");
    assert.equal(spawn.calls.steps[0].prompt, "C B-done", "C consumed B's journaled output");
    assert.equal(res.status, "passed");
    assert.equal(res.output, "C", "the run completes from C's fresh output");
  });
});

// ===========================================================================
// OUTPUT ROLL-UP NEVER SWALLOWS A FAILURE (MEDIUM)
// ===========================================================================

describe("graph scheduler — output roll-up never swallows a failure (MEDIUM)", () => {
  // Both feeders point at one output node, the PASSED one first. The old
  // "first non-skipped feeder" rule returned the passed value and swallowed the
  // later failure; the array-merge roll-up must fail the run instead.
  const multiFeeder = (): WorkflowGraph => valid({
    name: "multi-feeder-output",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "ok", kind: "worker", config: { prompt: "ok" } },
      { id: "bad", kind: "worker", config: { prompt: "bad" } },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "ok", port: "in" } },
      { from: { node: "in", port: "out" }, to: { node: "bad", port: "in" } },
      { from: { node: "ok", port: "out" }, to: { node: "out", port: "in" } },
      { from: { node: "bad", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  // Two output nodes; only the second one's feeder failed. maybeFinish must consider
  // ALL output nodes, not just the first, so the run fails.
  const multiOutput = (): WorkflowGraph => valid({
    name: "multi-output",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "ok", kind: "worker", config: { prompt: "ok" } },
      { id: "bad", kind: "worker", config: { prompt: "bad" } },
      { id: "out1", kind: "output", inputs: [{ name: "in", type: "any" }] },
      { id: "out2", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "ok", port: "in" } },
      { from: { node: "in", port: "out" }, to: { node: "bad", port: "in" } },
      { from: { node: "ok", port: "out" }, to: { node: "out1", port: "in" } },
      { from: { node: "bad", port: "out" }, to: { node: "out2", port: "in" } },
    ],
  });

  const failBad = (spec: { nodeId: string }): SpawnResponse =>
    spec.nodeId === "bad" ? { status: "failed", reason: "boom" } : { output: spec.nodeId };

  it("an output fed by [passed, failed] feeders fails the run (not the first passed value)", async () => {
    const { engine } = buildEngine(spawnPort(failBad));
    const res = await engine.run(multiFeeder(), {}, CTX);
    assert.equal(res.status, "failed", "any failed feeder fails the run");
  });

  it("a 2-output graph fails the run when ANY output node failed", async () => {
    const { engine } = buildEngine(spawnPort(failBad));
    const res = await engine.run(multiOutput(), {}, CTX);
    assert.equal(res.status, "failed", "the second output's failure is not ignored");
  });
});

// ===========================================================================
// D3 — A THROWING/ABORTED LEAF SETTLES ITS STEP ROW TERMINAL
// ===========================================================================

describe("D3 — a throwing/aborted leaf settles its step row terminal (never stuck 'running')", () => {
  // in → A → m(array merge) → out. A throws; because it feeds an ARRAY merge it
  // soft-fails to a failed token (the v1 fan-in behaviour), so the run RESOLVES
  // failed — and A's journal row must be terminal `failed`, not stuck `running`.
  const fanIn = (): WorkflowGraph => valid({
    name: "d3-fanin",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "A" } },
      { id: "m", kind: "merge", outputs: [{ name: "out", type: "array" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "A", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "m", port: "in" } },
      { from: { node: "m", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  // in → A → out (no fan-in). A throws → propagates → the run REJECTS (the v1
  // root/sequence behaviour), but the leaf row must STILL be terminal `failed`.
  const chain = (): WorkflowGraph => valid({
    name: "d3-chain",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "A" } },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "A", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("throw on a fan-in path: run resolves failed (unchanged) AND the leaf row is terminal failed", async () => {
    const spawn = spawnPort((spec): SpawnResponse => {
      if (spec.nodeId === "A") throw new Error("A blew up");
      return { output: spec.nodeId };
    });
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(fanIn(), {}, CTX);

    assert.equal(res.status, "failed", "run-level rollup unchanged: a fan-in throw rolls up failed");
    const row = deps.steps.findByNode("run", "A");
    assert.equal(row?.status, "failed", "D3: the row is terminal failed, not stuck 'running'");
    assert.notEqual(row?.endedAt, null, "the terminal row carries an endedAt");
  });

  it("throw on a propagate path: run rejects (unchanged) AND the leaf row is terminal failed", async () => {
    const spawn = spawnPort((spec): SpawnResponse => {
      if (spec.nodeId === "A") throw new Error("A blew up");
      return { output: spec.nodeId };
    });
    const { engine, deps } = buildEngine(spawn);
    await assert.rejects(engine.run(chain(), {}, CTX), /A blew up/);
    assert.equal(deps.steps.findByNode("run", "A")?.status, "failed", "D3: terminal failed even on the rejecting propagate path");
  });

  it("abort mid-run: the in-flight leaf row settles terminal failed and the run rejects (unchanged)", async () => {
    const blocker = new Promise<SpawnResponse>(() => {}); // never resolves
    const spawn = spawnPort(() => blocker);
    const controller = new AbortController();
    const { engine, deps } = buildEngine(spawn);
    const p = engine.run(chain(), {}, { ...CTX, signal: controller.signal });
    await tick();
    const running = deps.steps.findByNode("run", "A");
    assert.equal(running?.status, "running", "the leaf is in-flight before the abort");
    assert.equal(running?.workerId, spawn.calls.steps[0].workerId, "the spawn stamped the worker id onto the running row");
    controller.abort();
    await assert.rejects(p, /aborted/);
    const settled = deps.steps.findByNode("run", "A");
    assert.equal(settled?.status, "failed", "D3: the aborted in-flight leaf settled terminal, not left 'running'");
    assert.equal(settled?.workerId, spawn.calls.steps[0].workerId, "D3: the failed row RETAINS the stamped worker id (not clobbered to null)");
  });
});

// ===========================================================================
// D4 — A NODE FAILING PORT-INPUT VALIDATION STILL JOURNALS A FAILED ROW
// ===========================================================================

describe("D4 — a port-input validation failure journals a terminal failed row", () => {
  // A.out is `any` (authoring-compatible with B's `number` port); at RUNTIME A emits
  // a string, so the scheduler rejects it against B's declared port BEFORE B runs.
  const mismatch = (): WorkflowGraph => valid({
    name: "d4-mismatch",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "produce" }, outputs: [{ name: "out", type: "any" }] },
      { id: "B", kind: "worker", config: { prompt: "consume {{in.count}}" }, inputs: [{ name: "count", type: "number" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "A", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "count" } },
      { from: { node: "B", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("records a failed row naming the validation error, fails the run (unchanged), never spawns the node", async () => {
    const spawn = spawnPort((spec): SpawnResponse => (spec.nodeId === "A" ? { output: "hello" } : {}));
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(mismatch(), {}, CTX);

    assert.equal(res.status, "failed", "run-level failure unchanged");
    const row = deps.steps.findByNode("run", "B");
    assert.equal(row?.status, "failed", "D4: the validation-failed node now has a journal row");
    assert.match(String(row?.output), /input port "count" expected number, got string/, "the row carries the validation error");
    assert.notEqual(row?.endedAt, null, "the terminal row carries an endedAt");
    assert.ok(!spawn.calls.steps.some((s) => s.nodeId === "B"), "the mis-typed node never spawned a worker");
    assert.equal(deps.steps.findByNode("run", "A")?.status, "passed", "the upstream node still passed");
  });
});

// ===========================================================================
// RESUME — A TERMINALLY-FAILED LEAF RE-RUNS; PASSED NODES STILL REPLAY
// ===========================================================================

describe("resume — a terminally-failed leaf retries on resume; passed nodes replay (no re-run)", () => {
  // input → A → B → C → output. A journaled passed (replays), B journaled FAILED
  // (the D3 terminal row — must RE-RUN as a retry, not be skipped nor left dangling),
  // C un-journaled (the frontier).
  const graph: WorkflowGraph = {
    name: "chain2",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "A" } },
      { id: "B", kind: "worker", config: { prompt: "B {{nodes.A.output}}" } },
      { id: "C", kind: "worker", config: { prompt: "C {{nodes.B.output}}" } },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "A", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "A" } },
      { from: { node: "B", port: "out" }, to: { node: "C", port: "in" } },
      { from: { node: "B", port: "out" }, to: { node: "C", port: "B" } },
      { from: { node: "C", port: "out" }, to: { node: "out", port: "in" } },
    ],
  };

  it("replays passed A, re-runs the terminally-failed B, then runs frontier C — recovering the run", async () => {
    const spawn = spawnPort(echoNodeId);
    const { engine, deps } = buildEngine(spawn, {
      resolveDefinition: (name: string) => (name === "chain2" ? (graph as never) : null),
    });
    deps.runs.insert({
      id: "run", definitionName: "chain2", owner: "orch", anchorId: "run",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    deps.steps.upsert({
      id: "run:A", runId: "run", nodeId: "A", nodeType: "worker",
      status: "passed", workerId: "wA-old", output: "A-done", startedAt: 1, endedAt: 2,
    });
    // B's prior attempt ended terminally FAILED — the D3 fix wrote this row instead
    // of leaving it stuck 'running'. Resume must RETRY it (failed rows are not memoized).
    deps.steps.upsert({
      id: "run:B", runId: "run", nodeId: "B", nodeType: "worker",
      status: "failed", workerId: null, output: { error: "prior boom" }, startedAt: 1, endedAt: 2,
    });

    const res = await engine.resume("run", CTX);

    // A replays (not re-spawned); B retries; C runs as the frontier — no duplicate of A
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId).sort(), ["B", "C"], "A replayed; B retried; C ran");
    assert.equal(spawn.calls.steps.find((s) => s.nodeId === "B")?.prompt, "B A-done", "B re-ran against A's replayed output");
    assert.equal(res.status, "passed", "the retry recovered the run");
    assert.equal(res.output, "C", "the run completed from the frontier");
    assert.equal(deps.steps.findByNode("run", "B")?.status, "passed", "the journal now reflects the successful retry");
  });
});
