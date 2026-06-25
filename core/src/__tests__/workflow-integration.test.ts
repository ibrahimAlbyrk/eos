import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { wf } from "../workflow/dsl.ts";
import { buildEngine, spawnPort, tick, jsonReport, passSchema, type SpawnResponse } from "./helpers/workflowFakes.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import type { RunContext } from "../ports/WorkflowEngine.ts";

// Comprehensive INTEGRATION tests: the REAL engine + REAL built-in executors + the
// REAL registry (register-builtins) + REAL bindings/concurrency/transforms, with
// ONLY the spawn boundary faked (deterministic canned outcomes — no Claude). Every
// node type, the two canonical topologies, the expert pool, the concurrency cap,
// stop/abort, and resume are exercised end-to-end through the interpreter.

const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };

// A respond that echoes each node's id as its report text (= its output) — gives
// every step a stable, assertable output so binding data-flow can be traced
// across the tree.
const echoNodeId = (spec: { nodeId: string }): SpawnResponse => ({ reportText: spec.nodeId });

// A duck-typed Zod-like schema (core carries no `zod`): accepts { n: number }.
const numberSchema = {
  safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: unknown } {
    return v && typeof v === "object" && typeof (v as { n?: unknown }).n === "number"
      ? { success: true, data: v }
      : { success: false, error: new Error("n must be a number") };
  },
};

function run(def: WorkflowDefinition, args: unknown, spawn: ReturnType<typeof spawnPort>, over = {}) {
  const built = buildEngine(spawn, over);
  return { built, promise: built.engine.run(def, args, CTX) };
}

// ===========================================================================
// EVERY NODE TYPE
// ===========================================================================

describe("integration — leaf step (typed + text-fallback)", () => {
  it("typed step: extracts + validates the report's ```json block against the schema", async () => {
    const spawn = spawnPort((): SpawnResponse => ({ reportText: jsonReport({ n: 42 }) }));
    const def = wf.define("t", (b) => ({ root: b.step({ id: "s", prompt: "go", outputSchema: numberSchema }) }));
    const { promise } = run(def, {}, spawn);
    const result = await promise;
    assert.equal(result.status, "passed");
    assert.deepEqual(result.output, { n: 42 });
    // the schema instruction (a fenced json block) is appended to the prompt
    assert.match(spawn.calls.steps[0].prompt, /```json/);
  });

  it("text-fallback step: no schema ⇒ the report text is the output, prompt unmodified", async () => {
    const spawn = spawnPort((): SpawnResponse => ({ reportText: "plain report" }));
    const def = wf.define("t", (b) => ({ root: b.step({ id: "s", prompt: "go" }) }));
    const { promise } = run(def, {}, spawn);
    const result = await promise;
    assert.equal(result.status, "passed");
    assert.equal(result.output, "plain report");
    assert.equal(spawn.calls.steps[0].prompt, "go"); // no schema suffix
  });

  it("a failed report signal fails the step", async () => {
    const spawn = spawnPort((): SpawnResponse => ({ signal: "failed", reportText: "boom" }));
    const def = wf.define("t", (b) => ({ root: b.step({ id: "s", prompt: "go" }) }));
    const result = await run(def, {}, spawn).promise;
    assert.equal(result.status, "failed");
  });
});

describe("integration — sequence", () => {
  it("runs children in order, threading each output into the next prompt", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("seq", (b) => ({
      root: b.sequence([
        b.step({ id: "a", prompt: "A" }),
        b.step({ id: "b", prompt: "prev {{nodes.a.output}}" }),
        b.step({ id: "c", prompt: "prev {{nodes.b.output}}" }),
      ], "root"),
    }));
    const result = await run(def, {}, spawn).promise;
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["a", "b", "c"]);
    assert.equal(spawn.calls.steps[1].prompt, "prev a");
    assert.equal(spawn.calls.steps[2].prompt, "prev b");
    assert.equal(result.output, "c"); // the last child's output
  });
});

describe("integration — parallel (barrier)", () => {
  it("runs all children concurrently and aggregates their outputs in order", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("par", (b) => ({
      root: b.parallel([
        b.step({ id: "p0", prompt: "0" }),
        b.step({ id: "p1", prompt: "1" }),
        b.step({ id: "p2", prompt: "2" }),
      ], "par"),
    }));
    const result = await run(def, {}, spawn).promise;
    assert.equal(spawn.calls.steps.length, 3);
    assert.deepEqual(result.output, ["p0", "p1", "p2"]);
  });
});

describe("integration — conditional (then / else / skip)", () => {
  const mk = (flag: string, withElse: boolean) => {
    const def = wf.define("cond", (b) => ({
      root: b.conditional({
        id: "cond",
        predicate: { op: "eq", left: "{{args.flag}}", right: "go" },
        then: b.step({ id: "then", prompt: "then" }),
        else: withElse ? b.step({ id: "else", prompt: "else" }) : undefined,
      }),
    }));
    return { def, args: { flag } };
  };

  it("then branch when the predicate holds", async () => {
    const spawn = spawnPort(echoNodeId);
    const { def, args } = mk("go", true);
    const result = await run(def, args, spawn).promise;
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["then"]);
    assert.equal(result.output, "then");
  });

  it("else branch when the predicate fails and an else exists", async () => {
    const spawn = spawnPort(echoNodeId);
    const { def, args } = mk("stop", true);
    const result = await run(def, args, spawn).promise;
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["else"]);
    assert.equal(result.output, "else");
  });

  it("skips (no output, no spawn) when the predicate fails and there is no else", async () => {
    const spawn = spawnPort(echoNodeId);
    const { def, args } = mk("stop", false);
    const { built, promise } = run(def, args, spawn);
    const result = await promise;
    assert.equal(spawn.calls.steps.length, 0); // neither branch ran
    assert.equal(built.deps.steps.findByNode("run", "cond")?.status, "skipped"); // node skipped
    assert.equal(result.output, undefined);
  });
});

describe("integration — phase", () => {
  it("emits the human label on progress and passes the body result through", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("ph", (b) => ({ root: b.phase("build", b.step({ id: "s", prompt: "go" })) }));
    const { built, promise } = run(def, {}, spawn);
    const result = await promise;
    const labels = built.deps.progress as unknown as { steps: Array<{ nodeId: string; status: string }> };
    assert.ok(labels.steps.some((e) => e.nodeId === "build" && e.status === "running"));
    assert.ok(labels.steps.some((e) => e.nodeId === "build" && e.status === "passed"));
    assert.equal(result.output, "s");
  });
});

describe("integration — subWorkflow", () => {
  it("runs a resolved definition in an isolated scope seeded by the node args", async () => {
    const spawn = spawnPort();
    const subDef = wf.define("sub", (b) => ({ root: b.step({ id: "leaf", prompt: "sub {{args.x}}" }) }));
    const parentDef = wf.define("parent", (b) => ({ root: b.subWorkflow({ id: "call", name: "sub", args: { x: "hi" } }) }));
    const result = await run(parentDef, {}, spawn, {
      resolveDefinition: (name: string) => (name === "sub" ? subDef : null),
    }).promise;
    // the sub's leaf id is scoped under the call; its args resolve to the node args
    assert.equal(spawn.calls.steps.length, 1);
    assert.equal(spawn.calls.steps[0].nodeId, "leaf@call");
    assert.equal(spawn.calls.steps[0].prompt, "sub hi");
    assert.equal(result.output, "sub hi"); // bound into the parent under "call"
  });
});

describe("integration — forEach (runtime count + per-iteration id isolation)", () => {
  it("fans one body per runtime item with isolated ids and item/index locals", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("fe", (b) => ({
      root: b.forEach({ id: "each", over: "{{args.items}}", body: b.step({ id: "item", prompt: "do {{item}} #{{index}}" }) }),
    }));
    const { built, promise } = run(def, { items: ["x", "y", "z"] }, spawn);
    const result = await promise;
    assert.equal(spawn.calls.steps.length, 3); // count known only at runtime
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["item#0", "item#1", "item#2"]);
    assert.deepEqual(spawn.calls.steps.map((s) => s.prompt), ["do x #0", "do y #1", "do z #2"]);
    assert.deepEqual(result.output, ["item#0", "item#1", "item#2"]);
    // per-iteration journal isolation: each scoped node has its own row
    assert.ok(built.deps.steps.findByNode("run", "item#0"));
    assert.ok(built.deps.steps.findByNode("run", "item#2"));
    assert.equal(built.deps.steps.findByNode("run", "item"), null);
  });
});

describe("integration — pipeline (ACTUAL overlap, no stage barrier)", () => {
  it("lets item A finish its whole chain while item B is stuck at stage 0", async () => {
    let releaseB = (): void => {};
    const bGate = new Promise<void>((r) => { releaseB = r; });
    const log: string[] = [];
    const spawn = spawnPort(async (spec): Promise<SpawnResponse> => {
      log.push(spec.prompt);
      if (spec.prompt === "s0 B") await bGate;
      return {};
    });
    const def = wf.define("pipe", (b) => ({
      root: b.pipeline({ id: "p", over: "{{args.items}}", stages: [
        b.step({ id: "s0", prompt: "s0 {{item}}" }),
        b.step({ id: "s1", prompt: "s1 {{nodes.s0.output}}" }),
        b.step({ id: "s2", prompt: "s2 {{nodes.s1.output}}" }),
      ] }),
    }));
    const { promise } = run(def, { items: ["A", "B"] }, spawn);
    for (let i = 0; i < 8; i++) await tick();
    // A flowed through ALL three stages while B never advanced past stage 0 — a
    // stage-barrier impl would have stalled A's stage 1 waiting on B's stage 0.
    assert.ok(log.includes("s2 s1 s0 A"), "A completed its independent chain");
    assert.ok(!log.some((x) => x.includes("s0 B") && x.startsWith("s1")), "B did not advance past its blocked stage 0");
    releaseB();
    const result = await promise;
    assert.equal(result.status, "passed");
  });
});

describe("integration — loopUntil (iteration metadata drives termination)", () => {
  it("re-runs the body until lastCount hits 0, injecting the iteration index", async () => {
    const lists: string[][] = [["a", "b"], ["c"], []];
    // The body carries a schema so its array output flows through the engine's
    // JSON extractor (a no-schema step's output would be a string).
    const spawn = spawnPort((spec, index): SpawnResponse =>
      spec.nodeId.startsWith("tick") ? { reportText: jsonReport(lists[index] ?? []) } : {});
    const def = wf.define("loop", (b) => ({
      root: b.loopUntil({
        id: "loop",
        body: b.step({ id: "tick", prompt: "tick {{iteration}}", outputSchema: passSchema }),
        until: { op: "eq", left: "{{nodes.loop.lastCount}}", right: 0 },
        maxIterations: 5,
      }),
    }));
    const result = await run(def, {}, spawn).promise;
    assert.equal(spawn.calls.steps.length, 3); // stops the round the last result is empty
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["tick#0", "tick#1", "tick#2"]);
    // the iteration index is injected into each body prompt (schema suffix follows)
    assert.ok(spawn.calls.steps.every((s, i) => s.prompt.startsWith(`tick ${i}`)));
    assert.deepEqual(result.output, []);
  });
});

describe("integration — deterministic glue (transform/map/filter/dedup/tally/accumulate)", () => {
  it("applies registered pure fns in-process with NO spawns", async () => {
    const spawn = spawnPort();
    const def = wf.define("glue", (b) => ({
      root: b.sequence([
        b.map({ id: "m", fn: "double", over: "{{args.nums}}" }),
        b.filter({ id: "f", fn: "isTruthy", over: "{{args.mixed}}" }),
        b.dedup({ id: "d", over: "{{args.dups}}" }),
        b.tally({ id: "t", over: "{{args.tags}}" }),
        b.accumulate({ id: "acc", fn: "sum", over: "{{args.nums}}", init: 0 }),
        b.transform({ id: "tr", fn: "length", over: "{{args.nums}}" }),
      ], "root"),
    }));
    const built = buildEngine(spawn);
    built.transforms.register("double", (x) => Number(x) * 2);
    const result = await built.engine.run(
      def,
      { nums: [1, 2, 3], mixed: [0, "x", null, "y"], dups: ["a", "a", "b"], tags: ["x", "x", "y"] },
      CTX,
    );
    assert.equal(spawn.calls.steps.length, 0); // glue never spawns a worker
    assert.deepEqual(built.deps.steps.findByNode("run", "m")?.output, [2, 4, 6]);
    assert.deepEqual(built.deps.steps.findByNode("run", "f")?.output, ["x", "y"]);
    assert.deepEqual(built.deps.steps.findByNode("run", "d")?.output, ["a", "b"]);
    assert.deepEqual(built.deps.steps.findByNode("run", "t")?.output, { x: 2, y: 1 });
    assert.equal(built.deps.steps.findByNode("run", "acc")?.output, 6);
    assert.equal(built.deps.steps.findByNode("run", "tr")?.output, 3);
    assert.equal(result.output, 3); // sequence ⇒ the last node's output
  });
});

// ===========================================================================
// CANONICAL TOPOLOGIES
// ===========================================================================

describe("integration — canonical topology: 3 research → 5 analysis → 2 planning (§5.2)", () => {
  it("each phase is a barrier; analysis/planning synthesize the full prior corpus", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("rap", (b) => ({
      root: b.sequence([
        b.phase("research", b.parallel(Array.from({ length: 3 }, (_, i) =>
          b.step({ id: `research-${i}`, prompt: `r${i} {{args.topic}}` })))),
        b.phase("analysis", b.parallel(Array.from({ length: 5 }, (_, i) =>
          b.step({ id: `analysis-${i}`, prompt: `a${i} {{nodes.research-*.output}}` })))),
        b.phase("planning", b.parallel(Array.from({ length: 2 }, (_, i) =>
          b.step({ id: `plan-${i}`, prompt: `p${i} {{nodes.analysis-*.output}}` })))),
      ], "root"),
    }));
    await run(def, { topic: "X" }, spawn).promise;

    const order = spawn.calls.steps.map((s) => s.nodeId);
    assert.equal(order.length, 10); // 3 + 5 + 2
    // barrier ordering: ALL research before ANY analysis before ANY planning
    const idx = (p: string) => order.map((id, i) => (id.startsWith(p) ? i : -1)).filter((i) => i >= 0);
    assert.ok(Math.max(...idx("research")) < Math.min(...idx("analysis")));
    assert.ok(Math.max(...idx("analysis")) < Math.min(...idx("plan")));
    // analysis embeds the FULL research corpus via the fan-out glob
    const a0 = spawn.calls.steps.find((s) => s.nodeId === "analysis-0")!;
    assert.match(a0.prompt, /research-0/);
    assert.match(a0.prompt, /research-1/);
    assert.match(a0.prompt, /research-2/);
    // planning embeds all 5 analyses
    const p0 = spawn.calls.steps.find((s) => s.nodeId === "plan-0")!;
    assert.match(p0.prompt, /analysis-0/);
    assert.match(p0.prompt, /analysis-4/);
  });
});

describe("integration — canonical topology: A → {B,C} → D diamond", () => {
  it("B (parallel-3) and C (sequential-3) start together; D waits for BOTH", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("diamond", (b) => ({
      root: b.sequence([
        b.step({ id: "A", prompt: "A" }),
        b.parallel([
          b.parallel([
            b.step({ id: "B0", prompt: "B0 {{nodes.A.output}}" }),
            b.step({ id: "B1", prompt: "B1 {{nodes.A.output}}" }),
            b.step({ id: "B2", prompt: "B2 {{nodes.A.output}}" }),
          ], "B"),
          b.sequence([
            b.step({ id: "C0", prompt: "C0 {{nodes.A.output}}" }),
            b.step({ id: "C1", prompt: "C1 {{nodes.C0.output}}" }),
            b.step({ id: "C2", prompt: "C2 {{nodes.C1.output}}" }),
          ], "C"),
        ], "BC"),
        b.step({ id: "D", prompt: "D B={{nodes.B.output}} C={{nodes.C.output}}" }),
      ], "root"),
    }));
    const result = await run(def, {}, spawn).promise;

    const order = spawn.calls.steps.map((s) => s.nodeId);
    // A first, then B's whole fan-out interleaved with C's first step (they start
    // together), then C serializes, then D last.
    assert.deepEqual(order, ["A", "B0", "B1", "B2", "C0", "C1", "C2", "D"]);
    const at = (id: string) => order.indexOf(id);
    assert.ok(at("B0") < at("C1") && at("B1") < at("C1") && at("B2") < at("C1"), "B and C overlap");
    assert.ok(at("C0") < at("C1") && at("C1") < at("C2"), "C is sequential");
    // C reads the previous step each time
    assert.equal(spawn.calls.steps.find((s) => s.nodeId === "C1")!.prompt, "C1 C0");
    assert.equal(spawn.calls.steps.find((s) => s.nodeId === "C2")!.prompt, "C2 C1");
    // D consumes BOTH branches via bindings (B's aggregate + C's final output)
    const d = spawn.calls.steps.find((s) => s.nodeId === "D")!;
    assert.match(d.prompt, /B=\["B0","B1","B2"\]/);
    assert.match(d.prompt, /C=C2/);
    assert.equal(result.output, "D");
  });
});

// ===========================================================================
// EXPERT POOL · CONCURRENCY · STOP/ABORT · RESUME
// ===========================================================================

describe("integration — expert pool lifecycle (§4)", () => {
  const expertDef = (root: WorkflowDefinition["root"]): WorkflowDefinition =>
    wf.define("x", (_b) => ({
      experts: [
        { id: "e1", from: "e1", prompt: "stand by" },
        { id: "e2", from: "e2", prompt: "stand by" },
      ],
      root,
    }));

  it("spawns experts (persistent+collaborate, under the anchor) BEFORE steps, reaps in finally on success", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = expertDef({ type: "step", id: "s", prompt: "go" });
    await run(def, {}, spawn).promise;
    assert.deepEqual(spawn.calls.order, ["anchor:run", "expert:e1", "expert:e2", "step:s", "kill:run"]);
    assert.equal(spawn.calls.experts[0].persistent, true);
    assert.equal(spawn.calls.experts[0].collaborate, true);
    assert.equal(spawn.calls.experts[0].parentId, "run"); // = anchorId
  });

  it("threads the run owner (CTX.ownerId) onto step + expert specs as definitionOwnerId (§ITEM 4)", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = expertDef({ type: "step", id: "s", prompt: "go" });
    await run(def, {}, spawn).promise;
    // The spawn handler resolves the orchestrator's create_worker runtime defs by
    // the RUN OWNER, not the synthetic anchor id — so the engine must thread
    // ctx.ownerId ("orch") onto every step AND expert spec.
    assert.equal(spawn.calls.steps[0].definitionOwnerId, "orch");
    assert.ok(spawn.calls.experts.length === 2 && spawn.calls.experts.every((e) => e.definitionOwnerId === "orch"));
  });

  it("reaps the anchor in finally even when the run FAILS", async () => {
    const spawn = spawnPort((): SpawnResponse => ({ signal: "failed", reportText: "boom" }));
    const def = expertDef({ type: "step", id: "s", prompt: "go" });
    const result = await run(def, {}, spawn).promise;
    assert.equal(result.status, "failed");
    assert.deepEqual(spawn.calls.killed, ["run"]); // anchor subtree reaped
    assert.ok(spawn.calls.order.indexOf("expert:e1") < spawn.calls.order.indexOf("kill:run"));
  });

  it("reaps the anchor in finally even when the run is ABORTED", async () => {
    const blocker = new Promise<SpawnResponse>(() => {}); // never resolves
    const spawn = spawnPort(() => blocker);
    const def = expertDef({ type: "step", id: "s", prompt: "go" });
    const controller = new AbortController();
    const built = buildEngine(spawn);
    const p = built.engine.run(def, {}, { ...CTX, signal: controller.signal });
    await tick();
    controller.abort();
    await assert.rejects(p, /aborted/);
    assert.deepEqual(spawn.calls.killed, ["run"]);
    assert.ok(spawn.calls.experts.length === 2, "experts were spawned before the abort");
  });
});

describe("integration — ConcurrencyGate caps fan-out", () => {
  it("never runs more than maxConcurrentSteps spawns at once", async () => {
    let running = 0;
    let peak = 0;
    let releaseAll = (): void => {};
    const gate = new Promise<void>((r) => { releaseAll = r; });
    const spawn = spawnPort(async (): Promise<SpawnResponse> => {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;
      return {};
    });
    const def = wf.define("cap", (b) => ({
      root: b.parallel(Array.from({ length: 5 }, (_, i) => b.step({ id: `s${i}`, prompt: `${i}` })), "par"),
    }));
    const built = buildEngine(spawn, { maxConcurrentSteps: 2 });
    const p = built.engine.run(def, {}, CTX);
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(peak, 2, "the cap bounded concurrent fan-out to 2");
    releaseAll();
    await p;
    assert.equal(peak, 2, "the cap held across draining waves");
    assert.equal(spawn.calls.steps.length, 5); // all five still ran, just ≤2 at a time
  });
});

describe("integration — stop / abort mid-run", () => {
  it("a sequence rejects, the in-flight join rejects, and the anchor is killed", async () => {
    const blocker = new Promise<SpawnResponse>(() => {});
    const spawn = spawnPort(() => blocker);
    const def = wf.define("ab", (b) => ({ root: b.sequence([b.step({ id: "s", prompt: "go" })], "root") }));
    const controller = new AbortController();
    const built = buildEngine(spawn);
    const p = built.engine.run(def, {}, { ...CTX, signal: controller.signal });
    await tick();
    controller.abort();
    await assert.rejects(p, /aborted/);
    assert.deepEqual(spawn.calls.killed, ["run"]);
  });

  it("a composite stops spawning new children once aborted", async () => {
    const blocker = new Promise<SpawnResponse>(() => {});
    const spawn = spawnPort(() => blocker);
    const def = wf.define("ab2", (b) => ({
      root: b.forEach({ id: "each", over: "{{args.items}}", body: b.step({ id: "item", prompt: "go" }) }),
    }));
    const controller = new AbortController();
    const built = buildEngine(spawn, { maxConcurrentSteps: 2 });
    const p = built.engine.run(def, { items: [1, 2, 3, 4, 5, 6] }, { ...CTX, signal: controller.signal });
    await tick();
    assert.equal(spawn.calls.steps.length, 2, "only the cap's worth started before abort");
    controller.abort();
    const result = await p; // forEach degrades aborted children to failed, then settles
    assert.equal(result.status, "failed");
    assert.ok(spawn.calls.steps.length < 6, "no new children spawned after the abort");
    assert.deepEqual(spawn.calls.killed, ["run"]);
  });
});

describe("integration — resume (memoized replay, no re-spawn)", () => {
  it("a journaled `passed` step replays its output instead of re-spawning", async () => {
    const spawn = spawnPort(echoNodeId);
    const def = wf.define("wf", (b) => ({
      root: b.sequence([
        b.step({ id: "n1", from: "a", prompt: "p1" }),
        b.step({ id: "n2", from: "b", prompt: "use {{nodes.n1.output}}" }),
      ], "root"),
    }));
    const built = buildEngine(spawn, { resolveDefinition: (name: string) => (name === "wf" ? def : null) });
    // Seed an interrupted run: n1 already finished (journaled), n2 never ran.
    built.deps.runs.insert({
      id: "run", definitionName: "wf", owner: "orch", anchorId: "run",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    built.deps.steps.upsert({
      id: "run:n1", runId: "run", nodeId: "n1", nodeType: "step",
      status: "passed", workerId: "w-old", output: "journaled-n1", startedAt: 1, endedAt: 2,
    });

    const result = await built.engine.resume("run", CTX);

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["n2"], "only n2 re-spawns; n1 replays");
    assert.equal(spawn.calls.steps[0].prompt, "use journaled-n1", "n1's journaled output re-seeds the binding");
    assert.equal(result.status, "passed");
  });
});
