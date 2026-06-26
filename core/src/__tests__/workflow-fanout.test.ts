import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wf } from "../workflow/dsl.ts";
import { buildEngine, spawnPort, tick, jsonReport, passSchema, promptBody, type SpawnResponse } from "./helpers/workflowFakes.ts";

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
    // The body carries a schema so its array output flows through the engine's
    // JSON extractor; key the empty round off the scoped per-iteration node id.
    const spawn = spawnPort((spec): SpawnResponse =>
      ({ reportText: jsonReport(spec.nodeId === "s#2" ? [] : ["item"]) }));
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
