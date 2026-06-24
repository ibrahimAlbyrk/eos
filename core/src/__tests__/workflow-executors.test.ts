import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wf } from "../workflow/dsl.ts";
import { BindingScope } from "../workflow/bindings.ts";
import { conditionalExecutor } from "../workflow/executors/conditional.ts";
import { buildEngine, spawnPort, type SpawnResponse } from "./helpers/workflowFakes.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";

// A duck-typed Zod-like schema (core has no direct `zod`): accepts { n: number }.
const numberSchema = {
  safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: unknown } {
    return v && typeof v === "object" && typeof (v as { n?: unknown }).n === "number"
      ? { success: true, data: v }
      : { success: false, error: new Error("n must be a number") };
  },
};

const ctx = { runId: "r", ownerId: "o", mode: "default" as const };

describe("step executor — Zod validate-with-retry (§3.4)", () => {
  it("re-prompts on a schema failure then returns the parsed object", async () => {
    let n = 0;
    const spawn = spawnPort((): SpawnResponse => {
      n += 1;
      return n === 1 ? { output: { n: "nope" } } : { output: { n: 42 } };
    });
    const def = wf.define("retry", (b) => ({
      root: b.step({ id: "s", prompt: "compute it", outputSchema: numberSchema }),
    }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, {}, ctx);

    assert.deepEqual(res.output, { n: 42 });
    assert.equal(res.status, "passed");
    assert.equal(spawn.calls.steps.length, 2, "one retry spawn after the first invalid output");
    assert.match(spawn.calls.steps[1].prompt, /failed schema validation/);
    // the schema instruction is appended on the first attempt too
    assert.match(spawn.calls.steps[0].prompt, /submit_step_output/);
  });

  it("fails the step after exhausting retries", async () => {
    const spawn = spawnPort((): SpawnResponse => ({ output: { n: "always-bad" } }));
    const def = wf.define("retry-fail", (b) => ({
      root: b.step({ id: "s", prompt: "compute", outputSchema: numberSchema }),
    }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, {}, ctx);

    assert.equal(res.status, "failed");
    assert.equal(spawn.calls.steps.length, 3, "initial attempt + 2 retries");
  });

  it("maps a failed report signal to a failed step (no schema)", async () => {
    const spawn = spawnPort((): SpawnResponse => ({ signal: "failed", reportText: "blew up" }));
    const def = wf.define("sig", (b) => ({ root: b.step({ id: "s", prompt: "go" }) }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, {}, ctx);
    assert.equal(res.status, "failed");
  });
});

describe("sequence executor", () => {
  it("short-circuits on a failed child", async () => {
    const spawn = spawnPort((spec): SpawnResponse =>
      spec.prompt === "b" ? { signal: "failed", reportText: "b failed" } : {});
    const def = wf.define("seq", (b) => ({
      root: b.sequence([
        b.step({ id: "a", prompt: "a" }),
        b.step({ id: "b", prompt: "b" }),
        b.step({ id: "c", prompt: "c" }),
      ], "root"),
    }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, {}, ctx);

    assert.equal(res.status, "failed");
    assert.deepEqual(spawn.calls.steps.map((s) => s.prompt), ["a", "b"], "c never runs");
  });
});

describe("parallel executor — barrier", () => {
  it("awaits all children; a crashed child fails-soft without rejecting the barrier", async () => {
    const spawn = spawnPort((spec): SpawnResponse => {
      if (spec.prompt === "boom") throw new Error("worker crashed");
      return {};
    });
    const def = wf.define("par", (b) => ({
      root: b.parallel([
        b.step({ id: "ok1", prompt: "ok1" }),
        b.step({ id: "bad", prompt: "boom" }),
        b.step({ id: "ok2", prompt: "ok2" }),
      ], "root"),
    }));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(def, {}, ctx);

    assert.equal(res.status, "failed", "one failed child fails the barrier");
    assert.ok(Array.isArray(res.output) && res.output.length === 3, "all children aggregated");
    assert.equal(spawn.calls.steps.length, 3, "every child still spawned");
  });
});

describe("conditional executor", () => {
  const def = (then: string, els?: string): WorkflowDefinition => wf.define("cond", (b) => ({
    root: b.conditional({
      id: "c",
      predicate: { op: "exists", ref: "{{args.flag}}" },
      then: b.step({ id: "then", prompt: then }),
      else: els ? b.step({ id: "else", prompt: els }) : undefined,
    }),
  }));

  it("runs `then` when the predicate holds", async () => {
    const spawn = spawnPort();
    const { engine } = buildEngine(spawn);
    await engine.run(def("did-then", "did-else"), { flag: true }, ctx);
    assert.deepEqual(spawn.calls.steps.map((s) => s.prompt), ["did-then"]);
  });

  it("runs `else` when the predicate fails", async () => {
    const spawn = spawnPort();
    const { engine } = buildEngine(spawn);
    await engine.run(def("did-then", "did-else"), {}, ctx);
    assert.deepEqual(spawn.calls.steps.map((s) => s.prompt), ["did-else"]);
  });

  it("returns a skipped NodeResult (no branch) when the predicate fails and there is no else", async () => {
    // observed at the node level — the engine maps a non-passed root to a failed
    // RUN, so assert the executor directly: skip means no branch executed.
    const node = {
      type: "conditional" as const,
      id: "c",
      predicate: { op: "exists" as const, ref: "{{args.flag}}" },
      then: { type: "step" as const, id: "then", prompt: "did-then" },
    };
    const engineSpy = { runNode: () => { throw new Error("must not run a branch"); } };
    const res = await conditionalExecutor.execute(node, {
      bindings: new BindingScope({}),
      engine: engineSpy,
    } as unknown as Parameters<typeof conditionalExecutor.execute>[1]);
    assert.deepEqual(res, { output: undefined, status: "skipped" });
  });
});

describe("phase executor", () => {
  it("emits a step-change carrying the label, then runs the body", async () => {
    const spawn = spawnPort();
    const def = wf.define("ph", (b) => ({
      root: b.phase("research", b.step({ id: "s", prompt: "go" }), "ph"),
    }));
    const { engine, deps } = buildEngine(spawn);
    await engine.run(def, {}, ctx);

    const progress = deps.progress as ReturnType<typeof import("./helpers/workflowFakes.ts").progressSink>;
    const labelEvents = progress.steps.filter((s) => s.nodeId === "research");
    assert.deepEqual(labelEvents.map((e) => e.status), ["running", "passed"]);
    assert.equal(spawn.calls.steps.length, 1);
  });
});

describe("subWorkflow executor", () => {
  it("resolves a stored definition, runs it in an isolated arg scope, and binds its output", async () => {
    const sub = wf.define("sub", (b) => ({
      root: b.step({ id: "inner", prompt: "sub {{args.q}}" }),
    }));
    const spawn = spawnPort();
    const def = wf.define("parent", (b) => ({
      root: b.sequence([
        b.subWorkflow({ id: "sw", name: "sub", args: { q: "hello" } }),
        b.step({ id: "after", prompt: "after {{nodes.sw.output}}" }),
      ], "root"),
    }));
    const { engine, deps } = buildEngine(spawn, {
      resolveDefinition: (name) => (name === "sub" ? sub : null),
    });
    await engine.run(def, { q: "PARENT-ARG" }, ctx);

    // the sub-workflow sees ITS OWN args, not the parent's
    assert.equal(spawn.calls.steps[0].prompt, "sub hello");
    // its output flowed to the parent under the subWorkflow node id
    assert.equal(spawn.calls.steps[1].prompt, "after sub hello");
    // its node ids were scoped (no collision with parent journal)
    const steps = deps.steps as ReturnType<typeof import("./helpers/workflowFakes.ts").stepRepo>;
    assert.ok(steps.findByNode("r", "inner@sw"), "sub node id scoped under the call");
  });

  it("throws a clear error for an unknown sub-workflow name", async () => {
    const spawn = spawnPort();
    const def = wf.define("p2", (b) => ({ root: b.subWorkflow({ id: "sw", name: "missing" }) }));
    const { engine } = buildEngine(spawn, { resolveDefinition: () => null });
    await assert.rejects(engine.run(def, {}, ctx), /subWorkflow definition "missing" not found/);
  });
});
