import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wf } from "../workflow/dsl.ts";
import { buildEngine, spawnPort, tick, passSchema, promptBody, type SpawnResponse } from "./helpers/workflowFakes.ts";

const ctx = { runId: "r", ownerId: "o", mode: "default" as const };

describe("pipeline executor — independent per-item chains (§3.2 landmine)", () => {
  it("runs each item through ALL stages with NO barrier between stages", async () => {
    // item "B" blocks at its first stage; a barrier-between-stages impl would
    // stall item "A" at stage 1 waiting on B's stage 0. The correct impl lets A
    // finish its whole chain while B is still stuck.
    let releaseB = (): void => {};
    const bGate = new Promise<void>((r) => { releaseB = r; });
    const log: string[] = [];
    const spawn = spawnPort(async (spec): Promise<SpawnResponse> => {
      const body = promptBody(spec.prompt);
      log.push(body);
      if (body === "s0 B") await bGate;
      return {};
    });
    const def = wf.define("pipe", (b) => ({
      root: b.pipeline({ id: "p", over: "{{args.items}}", stages: [
        b.step({ id: "s0", prompt: "s0 {{item}}" }),
        b.step({ id: "s1", prompt: "s1 {{nodes.s0.output}}" }),
        b.step({ id: "s2", prompt: "s2 {{nodes.s1.output}}" }),
      ] }),
    }));
    const { engine } = buildEngine(spawn);
    const runP = engine.run(def, { items: ["A", "B"] }, ctx);

    for (let i = 0; i < 20; i++) await tick();

    assert.ok(log.includes("s2 s1 s0 A"), "item A reached its final stage while B blocked at stage 0");
    assert.ok(!log.some((p) => p.startsWith("s1 s0 B")), "item B never advanced past its blocked stage 0");

    releaseB();
    const res = await runP;
    assert.equal(res.status, "passed");
    // each item's last-stage output aggregated
    assert.deepEqual(res.output, ["s2 s1 s0 A", "s2 s1 s0 B"]);
  });
});

describe("forEach executor — per-iteration id isolation + item injection", () => {
  it("scopes every body node per item and rewrites in-body cross refs", async () => {
    const spawn = spawnPort();
    const def = wf.define("fe", (b) => ({
      root: b.forEach({ id: "fe", over: "{{args.items}}", body:
        b.sequence([
          b.step({ id: "a", prompt: "a {{item}}" }),
          b.step({ id: "b", prompt: "b {{nodes.a.output}}" }),
        ], "body") }),
    }));
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(def, { items: ["x", "y"] }, ctx);

    // item injected (a) + sibling ref resolved within the SAME iteration (b)
    assert.deepEqual(spawn.calls.steps.map((s) => promptBody(s.prompt)).sort(), ["a x", "a y", "b a x", "b a y"]);
    // four distinct journal rows — body ids scoped per iteration, no collision
    const steps = deps.steps as ReturnType<typeof import("./helpers/workflowFakes.ts").stepRepo>;
    for (const id of ["a#0", "b#0", "a#1", "b#1"]) {
      assert.ok(steps.findByNode("r", id), `journal row ${id} present`);
    }
    assert.ok(Array.isArray(res.output) && res.output.length === 2, "per-item outputs aggregated");
  });

  it("fans out over an empty list to an empty aggregate (no spawns)", async () => {
    const spawn = spawnPort();
    const def = wf.define("fe0", (b) => ({
      root: b.forEach({ id: "fe", over: "{{args.items}}", body: b.step({ id: "a", prompt: "a {{item}}" }) }),
    }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, { items: [] }, ctx);
    assert.deepEqual(res.output, []);
    assert.equal(spawn.calls.steps.length, 0);
  });
});

describe("loopUntil executor — per-iteration id isolation + termination", () => {
  it("re-runs the body maxIterations times with isolated ids and injected iteration", async () => {
    const spawn = spawnPort();
    const def = wf.define("lu", (b) => ({
      root: b.loopUntil({ id: "loop", maxIterations: 3, body: b.step({ id: "s", prompt: "round {{iteration}}" }) }),
    }));
    const { engine, deps } = buildEngine(spawn);
    await engine.run(def, {}, ctx);

    assert.deepEqual(spawn.calls.steps.map((s) => promptBody(s.prompt)), ["round 0", "round 1", "round 2"]);
    const steps = deps.steps as ReturnType<typeof import("./helpers/workflowFakes.ts").stepRepo>;
    for (const id of ["s#0", "s#1", "s#2"]) assert.ok(steps.findByNode("r", id), `journal row ${id}`);
  });

  it("stops early when the until predicate sees an empty last round (lastCount)", async () => {
    // The body carries a schema so its array output is validated by the engine;
    // key the empty round off the scoped per-iteration node id.
    const spawn = spawnPort((spec): SpawnResponse =>
      ({ output: spec.nodeId === "s#2" ? [] : ["item"] }));
    const def = wf.define("lu2", (b) => ({
      root: b.loopUntil({
        id: "loop",
        maxIterations: 10,
        until: { op: "eq", left: "{{nodes.loop.lastCount}}", right: 0 },
        body: b.step({ id: "s", prompt: "round {{iteration}}", outputSchema: passSchema }),
      }),
    }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, {}, ctx);

    assert.equal(spawn.calls.steps.length, 3, "stops the round after the body returns an empty list");
    assert.deepEqual(res.output, []);
  });

  it("fails loud when neither until nor maxIterations is set", async () => {
    const spawn = spawnPort();
    const def = wf.define("lu-bad", (b) => ({
      root: b.loopUntil({ id: "loop", body: b.step({ id: "s", prompt: "x" }) }),
    }));
    const { engine } = buildEngine(spawn);
    await assert.rejects(engine.run(def, {}, ctx), /requires 'until' or 'maxIterations'/);
  });
});

// D2 — a loop-in-loop must compose the outer+inner id suffixes so every logical
// inner iteration gets a DISTINCT journal PK. Before the fix scopeGraphConfig did
// not descend into a loop's config.body, so the inner body re-ran with only its
// own per-iteration suffix and its PK collided across outer iterations (last-write-
// wins → under-counted iterations + mis-attributed outputs).
describe("D2 — nested loop (loop-in-loop) journal PK composition", () => {
  // outer over 2 groups, inner over each group's items: 2 + 1 = 3 logical inner
  // iterations. Composed ids: w#0#0, w#0#1 (group 0), w#1#0 (group 1).
  const nested = wf.define("nested", (b) => ({
    root: b.forEach({ id: "outer", over: "{{args.groups}}", body:
      b.forEach({ id: "inner", over: "{{item}}", body:
        b.step({ id: "w", prompt: "do {{item}}" }) }) }),
  }));

  it("journals each inner iteration under a distinct composed PK with correctly-attributed outputs", async () => {
    const spawn = spawnPort();
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(nested, { groups: [["a", "b"], ["c"]] }, ctx);

    // three distinct inner iterations spawn three workers with composed ids
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId).sort(), ["w#0#0", "w#0#1", "w#1#0"]);
    // each composed PK has its OWN journal row carrying its OWN item's output —
    // no collision means no last-write-wins clobbering across outer iterations
    assert.equal(deps.steps.findByNode("r", "w#0#0")?.output, "do a");
    assert.equal(deps.steps.findByNode("r", "w#0#1")?.output, "do b");
    assert.equal(deps.steps.findByNode("r", "w#1#0")?.output, "do c");
    // the un-composed (colliding) ids never appear — the pre-fix collapse is gone
    assert.equal(deps.steps.findByNode("r", "w#0"), null);
    assert.equal(deps.steps.findByNode("r", "w"), null);
    // exactly three worker rows journaled (no under-counting)
    assert.equal(deps.steps.listByRun("r").filter((s) => s.nodeType === "step").length, 3);
    // outputs aggregate per outer iteration, inner-item order preserved
    assert.deepEqual(res.output, [["do a", "do b"], ["do c"]]);
    assert.equal(res.status, "passed");
  });

  it("composes PKs across loop KINDS — a loopUntil nested in a forEach (both lower to kind:loop)", async () => {
    // forEach (outer) over 2 items, each running a loopUntil (inner) of 2 iterations
    // → 4 logical inner iterations. The deep-scope fires for any kind:"loop" body, so
    // the composed ids must be w#0#0, w#0#1, w#1#0, w#1#1 (outer#item then inner#iter).
    const crossKind = wf.define("cross-kind", (b) => ({
      root: b.forEach({ id: "outer", over: "{{args.items}}", body:
        b.loopUntil({ id: "inner", maxIterations: 2, body:
          b.step({ id: "w", prompt: "{{item}}@{{iteration}}" }) }) }),
    }));
    const spawn = spawnPort();
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(crossKind, { items: ["a", "b"] }, ctx);

    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId).sort(), ["w#0#0", "w#0#1", "w#1#0", "w#1#1"]);
    assert.equal(deps.steps.findByNode("r", "w#0#0")?.output, "a@0");
    assert.equal(deps.steps.findByNode("r", "w#0#1")?.output, "a@1");
    assert.equal(deps.steps.findByNode("r", "w#1#0")?.output, "b@0");
    assert.equal(deps.steps.findByNode("r", "w#1#1")?.output, "b@1");
    assert.equal(deps.steps.listByRun("r").filter((s) => s.nodeType === "step").length, 4, "four distinct inner iterations, no collision");
    // loopUntil yields its last iteration's output; the forEach aggregates per item
    assert.deepEqual(res.output, ["a@1", "b@1"]);
    assert.equal(res.status, "passed");
  });

  it("leaves a SINGLE-level loop's journal unchanged (descent never fires for it)", async () => {
    const spawn = spawnPort();
    const single = wf.define("single", (b) => ({
      root: b.forEach({ id: "each", over: "{{args.items}}", body: b.step({ id: "x", prompt: "do {{item}}" }) }),
    }));
    const { engine, deps } = buildEngine(spawn);
    await engine.run(single, { items: ["p", "q"] }, ctx);
    // plain single-suffix ids — identical to the pre-fix journal, no extra composition
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId).sort(), ["x#0", "x#1"]);
    assert.ok(deps.steps.findByNode("r", "x#0") && deps.steps.findByNode("r", "x#1"));
    assert.equal(deps.steps.findByNode("r", "x#0#0"), null, "no spurious composed id for a single-level loop");
  });

  it("RESUME: replays journaled inner iterations by composed PK and runs only the un-journaled frontier", async () => {
    const spawn = spawnPort();
    const { engine, deps } = buildEngine(spawn, { resolveDefinition: (name: string) => (name === "nested" ? nested : null) });
    // An interrupted nested-loop run: group 0's two inner iterations already
    // journaled `passed` (under their composed PKs); group 1's iteration never ran.
    deps.runs.insert({ id: "r", definitionName: "nested", owner: "o", anchorId: "r", status: "running", args: { groups: [["a", "b"], ["c"]] }, startedAt: 1, updatedAt: 1 });
    deps.steps.upsert({ id: "r:w#0#0", runId: "r", nodeId: "w#0#0", nodeType: "step", status: "passed", workerId: null, output: "seed-00", startedAt: 1, endedAt: 2 });
    deps.steps.upsert({ id: "r:w#0#1", runId: "r", nodeId: "w#0#1", nodeType: "step", status: "passed", workerId: null, output: "seed-01", startedAt: 1, endedAt: 2 });

    const res = await engine.resume("r", ctx);

    // only the frontier inner iteration re-spawns; the two journaled ones replay
    assert.deepEqual(spawn.calls.steps.map((s) => s.nodeId), ["w#1#0"], "no missed or duplicated iteration — only the frontier ran");
    assert.equal(promptBody(spawn.calls.steps[0].prompt), "do c");
    // the replayed outputs come straight from the journal, the frontier from the fresh run
    assert.deepEqual(res.output, [["seed-00", "seed-01"], ["do c"]]);
    assert.equal(res.status, "passed");
  });
});
