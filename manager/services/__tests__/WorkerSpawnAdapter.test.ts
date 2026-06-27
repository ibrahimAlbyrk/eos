import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkerSpawnAdapter } from "../WorkerSpawnAdapter.ts";
import { EventBusProgressSink } from "../EventBusProgressSink.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";
import { runLoopTick, type RunLoopTickDeps } from "../../../core/src/use-cases/runLoopTick.ts";
import { classifyReport, stepStatusOfSignal } from "../../../core/src/domain/report-signal.ts";
import type { LoopRow } from "../../../core/src/ports/LoopStateRepo.ts";
import type { GoalSpec, GoalVerdict, SpawnLoop } from "../../../contracts/src/loop.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A minimal synchronous EventBus: publish fans out to topic subscribers + "*".
function fakeBus() {
  const subs = new Map<string, Set<EventBusSubscriber>>();
  const bus = {
    subs,
    published: [] as Array<{ topic: string; payload: unknown }>,
    publish(topic: string, payload: unknown) {
      bus.published.push({ topic, payload });
      for (const fn of subs.get(topic) ?? []) fn({ topic: topic as never, payload, ts: 0 });
      for (const fn of subs.get("*") ?? []) fn({ topic: topic as never, payload, ts: 0 });
    },
    subscribe(topic: string, fn: EventBusSubscriber) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic)!.add(fn);
      return () => subs.get(topic)!.delete(fn);
    },
  };
  return bus;
}

// Records setStatus/setOutput/setWorker so the durable writes are assertable.
function fakeSteps() {
  const rows = new Map<string, { status?: string; output?: unknown; workerId?: string }>();
  const key = (r: string, n: string) => `${r}:${n}`;
  return {
    rows, key,
    upsert() {}, listByRun() { return []; }, findByNode() { return null; },
    setStatus(r: string, n: string, status: string) {
      const row = rows.get(key(r, n)) ?? {}; row.status = status; rows.set(key(r, n), row);
    },
    setOutput(r: string, n: string, output: unknown) {
      const row = rows.get(key(r, n)) ?? {}; row.output = output; rows.set(key(r, n), row);
    },
    setWorker(r: string, n: string, workerId: string) {
      const row = rows.get(key(r, n)) ?? {}; row.workerId = workerId; rows.set(key(r, n), row);
    },
  };
}

function makeAdapter(opts: { stepTimeoutMs?: number } = {}) {
  const bus = fakeBus();
  const steps = fakeSteps();
  const inserted: Array<Record<string, unknown>> = [];
  const killed: string[] = [];
  const spawned: Array<Record<string, unknown>> = [];
  let n = 0;
  const deps = {
    bus: bus as unknown as EventBus,
    steps: steps as never,
    workers: { insert: (row: Record<string, unknown>) => { inserted.push(row); } },
    clock: { now: () => 1000 },
    runSpawn: async (req: Record<string, unknown>) => { spawned.push(req); return { id: `w-${++n}` }; },
    killWorker: (id: string) => { killed.push(id); },
    stepTimeoutMs: opts.stepTimeoutMs ?? 0, // off by default so existing tests arm no timer
  };
  const adapter = new WorkerSpawnAdapter(deps as never);
  return { adapter, bus, steps, inserted, killed, spawned };
}

// The SOLE settle channel: a workflow-worker node's typed output (the /step-output
// route publishes this). `held` defaults off (the terminal, released output).
const stepOutput = (
  bus: { publish(t: string, p: unknown): void },
  workerId: string,
  payload: { status?: string; output?: unknown; reason?: string; held?: boolean } = {},
) => bus.publish("workflow:step-output", { workerId, status: "done", ...payload });

// A turn-end IDLE — the adapter no longer subscribes to worker:change, so this is
// a no-op that must NOT settle a step (asserted below).
const idle = (bus: { publish(t: string, p: unknown): void }, workerId: string) =>
  bus.publish("worker:change", { workerId, from: "WORKING", state: "IDLE" });

const stepSpec = (over: Record<string, unknown> = {}) => ({
  runId: "run-1", nodeId: "n1", parentId: "anchor-1",
  prompt: "do the thing", mode: "acceptEdits", role: "workflow-worker", collaborate: false, ...over,
}) as never;

describe("WorkerSpawnAdapter — spawn-join", () => {
  it("resolves a step from a released workflow:step-output", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    stepOutput(bus, "w-1", { status: "done", output: "shipped" });
    const outcome = await p;
    assert.equal(outcome.workerId, "w-1");
    assert.equal(outcome.output, "shipped");
    assert.equal(outcome.status, "done");
  });

  it("forwards role=workflow-worker + collaborate:false onto the step spawn request", async () => {
    const { adapter, bus, spawned } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    assert.equal(spawned[0].role, "workflow-worker");
    assert.equal(spawned[0].collaborate, false);
    stepOutput(bus, "w-1", { status: "done", output: "ok" });
    await p;
  });

  it("a failed status surfaces the reason as the outcome", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    stepOutput(bus, "w-1", { status: "failed", reason: "could not build" });
    const outcome = await p;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "could not build");
  });

  it("stamps the step-worker id onto the running row at spawn (§3.7 recovery key)", async () => {
    const { adapter, bus, steps } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick(); // let runSpawn resolve + the stamp + the join register
    // The id is durably linked to the node BEFORE any output — so a crash in the
    // await window leaves a `running` row the boot re-arm can match + recover.
    assert.equal(steps.rows.get(steps.key("run-1", "n1"))?.workerId, "w-1");
    stepOutput(bus, "w-1", { status: "done", output: "ok" }); // settle so the promise never dangles
    await p;
  });

  it("ignores a held output and settles on the later released output", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    let settled = false;
    void p.then(() => { settled = true; });
    stepOutput(bus, "w-1", { status: "done", output: "premature", held: true });
    await tick();
    assert.equal(settled, false, "a held output must not settle the join");
    stepOutput(bus, "w-1", { status: "done", output: "verified" });
    const outcome = await p;
    assert.equal(outcome.output, "verified");
  });

  // Fail-closed: with last-message capture removed, a node settles via NOTHING but
  // the output tool. A turn-end IDLE must NOT settle it — only the timeout (or the
  // tool) can.
  it("does NOT settle on turn-end IDLE — only workflow_step_output settles", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    let settled = false;
    void p.then(() => { settled = true; });
    idle(bus, "w-1"); // the worker ended its turn without emitting — must NOT settle
    await tick();
    assert.equal(settled, false, "a turn-end IDLE must not settle a workflow node");
    stepOutput(bus, "w-1", { status: "done", output: "emitted" }); // settle so it never dangles
    assert.equal((await p).output, "emitted");
  });

  it("resolves via the output tool; a following IDLE is a no-op (resolve-once)", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    stepOutput(bus, "w-1", { status: "done", output: "shipped" });
    const outcome = await p;
    assert.equal(outcome.output, "shipped");
    // The turn-end IDLE that follows must not re-settle (join is gone).
    idle(bus, "w-1");
    assert.equal((await p).output, "shipped"); // unchanged — first settle won
  });

  it("a LOOPED step's held output does NOT settle — only the released republish does", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec({ loop: { goal: { summary: "g", criteria: [] }, strategy: "hybrid" } }), new AbortController().signal);
    await tick();
    let settled = false;
    void p.then(() => { settled = true; });
    stepOutput(bus, "w-1", { status: "done", output: "premature", held: true });
    idle(bus, "w-1"); // an iteration boundary — must NOT settle
    await tick();
    assert.equal(settled, false, "a held looped output must not settle the join");
    stepOutput(bus, "w-1", { status: "done", output: "verified", held: false }); // release
    const outcome = await p;
    assert.equal(outcome.output, "verified");
  });

  it("rejects after stepTimeoutMs when a step never emits its output", async () => {
    const { adapter, killed } = makeAdapter({ stepTimeoutMs: 20 });
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    // No output tool call, no exit → only the backstop can settle it (fail-closed).
    await assert.rejects(p, /timed out after 20ms/);
    assert.deepEqual(killed, ["w-1"]); // the stuck worker is reaped
  });

  it("an IDLE with no emitted output does NOT settle (waits for the timeout)", async () => {
    const { adapter, bus } = makeAdapter({ stepTimeoutMs: 20 });
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    idle(bus, "w-1"); // turn ended but emitted no output via the tool
    await assert.rejects(p, /timed out after 20ms/);
  });

  it("rejects when a worker exits before reporting (crash)", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    bus.publish("worker:exit", { workerId: "w-1" });
    await assert.rejects(p, /exited before reporting/);
  });

  it("does NOT reject on exit after a (held) output was seen", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    let outcome: unknown = "pending";
    void p.then((o) => { outcome = o; }, (e) => { outcome = e; });
    stepOutput(bus, "w-1", { status: "done", output: "held", held: true });
    bus.publish("worker:exit", { workerId: "w-1" });
    await tick();
    assert.equal(outcome, "pending", "an emitted-then-exited worker keeps waiting for the release");
  });

  it("the run anchor's own exit never settles a step", async () => {
    const { adapter, bus } = makeAdapter();
    adapter.mintRunAnchor("anchor-1", "orch-1", "acceptEdits");
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    let outcome: unknown = "pending";
    void p.then((o) => { outcome = o; }, (e) => { outcome = e; });
    bus.publish("worker:exit", { workerId: "anchor-1" }); // the anchor's spurious boot-reconcile exit
    await tick();
    assert.equal(outcome, "pending", "the anchor's exit must be filtered by id");
    stepOutput(bus, "w-1", { status: "done", output: "ok" });
    assert.equal((await p).status, "done");
  });

  it("first settle wins (resolve-once) across exit then output", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    bus.publish("worker:exit", { workerId: "w-1" }); // first settle = reject
    stepOutput(bus, "w-1", { status: "done", output: "late" }); // ignored
    await assert.rejects(p, /exited before reporting/);
  });

  it("aborts the join and reaps the worker on signal abort", async () => {
    const { adapter, killed } = makeAdapter();
    const ac = new AbortController();
    const p = adapter.spawnAndAwait(stepSpec(), ac.signal);
    await tick();
    ac.abort();
    await assert.rejects(p, /aborted/);
    assert.deepEqual(killed, ["w-1"]);
  });

  it("mints a synthetic anchor row owned by the orchestrator", () => {
    const { adapter, inserted } = makeAdapter();
    const id = adapter.mintRunAnchor("run-9", "orch-7", "bypassPermissions");
    assert.equal(id, "run-9");
    const row = inserted[0];
    assert.equal(row.id, "run-9");
    assert.equal(row.parentId, "orch-7");
    assert.equal(row.isOrchestrator, true);
    assert.equal(row.prompt, "[workflow-run anchor]");
    assert.equal(row.pid, null);
    assert.equal(row.worktreeFrom, null);
  });

  it("forwards definitionOwnerId onto the step spawn request (resolves run-owner create_worker defs — §ITEM 4)", async () => {
    const { adapter, bus, spawned } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec({ definitionOwnerId: "orch-1" }), new AbortController().signal);
    await tick();
    // parentId is the synthetic anchor, but the runtime-def owner is the run owner.
    assert.equal(spawned[0].parentId, "anchor-1");
    assert.equal(spawned[0].definitionOwnerId, "orch-1");
    stepOutput(bus, "w-1", { status: "done", output: "ok" });
    await p;
  });

  it("spawnExpert spawns a persistent, collaborate, named mesh provider under the anchor", async () => {
    const { adapter, spawned } = makeAdapter();
    const { workerId } = await adapter.spawnExpert({
      runId: "run-1", parentId: "anchor-1", definitionOwnerId: "orch-1", name: "solid-expert", from: "solid-expert",
      prompt: "stand by", mode: "acceptEdits", persistent: true, collaborate: true,
    } as never);
    assert.equal(workerId, "w-1");
    const req = spawned[0];
    assert.equal(req.parentId, "anchor-1");
    assert.equal(req.definitionOwnerId, "orch-1"); // run owner → resolves create_worker defs
    assert.equal(req.name, "solid-expert");
    assert.equal(req.persistent, true);
    assert.equal(req.collaborate, true);
    assert.equal(req.permissionMode, "acceptEdits");
  });
});

// The step-loop release bridge (§ITEM 7 / D3): a step armed with a `loop` HOLDS its
// first output (the /step-output route publishes workflow:step-output{held:true});
// the join must keep waiting. The goal-check release runs through the REAL
// runLoopTick, whose releaseReport is wired EXACTLY like manager/daemon.ts — it
// republishes the terminal workflow:step-output{held:false} that the adapter's
// onStepOutput keys on. So this exercises the whole chain: held → goal-met tick →
// daemon republish → join.
describe("WorkerSpawnAdapter — step loop release bridge (§ITEM 7)", () => {
  const GOAL: GoalSpec = { summary: "tests green", criteria: [{ id: "c1", text: "npm test passes", verify: "npm test" }] };
  const STEP_LOOP: SpawnLoop = { goal: GOAL, strategy: "hybrid" };

  function loopRow(over: Partial<LoopRow> = {}): LoopRow {
    return {
      id: "l-1", workerId: "w-1", parentId: "anchor-1", goal: GOAL, strategy: "hybrid",
      status: "active", attempt: 0, maxAttempts: null, heldReport: null, heldOutput: null, lastReason: null,
      awaitingInput: false, progressRing: [], startedAt: 1000, updatedAt: 1000, ...over,
    };
  }

  const goalMet: GoalVerdict = {
    met: true, criteria: [{ id: "c1", met: true, evidence: "exit 0" }], unmet: [], confidence: 1, reason: "all criteria met",
  };
  const goalUnmet: GoalVerdict = {
    met: false, criteria: [{ id: "c1", met: false }], unmet: [{ id: "c1", reason: "still failing" }], confidence: 1, reason: "not yet",
  };

  // runLoopTick deps whose releaseReport mirrors manager/daemon.ts: republish the
  // STRUCTURED held output verbatim (typed object + its self-declared status) so a
  // released looped step delivers its object and a failed step stays failed. Falls
  // back to the text-derived signal only when there is no structured held output.
  function tickDeps(bus: ReturnType<typeof fakeBus>, loop: LoopRow, verdict: GoalVerdict = goalMet): RunLoopTickDeps {
    return {
      loops: { findActiveByWorker: () => loop, setStatus() {}, recordAttempt() {}, setHeldReport() {}, setHeldOutput() {} },
      strategyFor: () => ({ evaluate: async () => verdict }),
      dispatch: async () => ({}),
      releaseReport: async ({ workerId, parentId, text }: { workerId: string; parentId: string; text: string }) => {
        const held = loop.heldOutput;
        bus.publish("workflow:step-output", held
          ? { workerId, parentId, output: held.output, status: held.status, reason: held.reason, held: false }
          : { workerId, parentId, output: text, status: stepStatusOfSignal(classifyReport(text)), held: false });
        return {};
      },
      stateHash: async () => "h",
      noProgressWindow: 3,
      stopOnNoProgress: true,
      renderer: { render: () => "rendered" },
      clock: { now: () => 1234 },
      log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    } as unknown as RunLoopTickDeps;
  }

  it("PART A — threads the loop onto the step spawn request", async () => {
    const { adapter, bus, spawned } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec({ loop: STEP_LOOP }), new AbortController().signal);
    await tick();
    assert.deepEqual(spawned[0].loop, STEP_LOOP);
    stepOutput(bus, "w-1", { status: "done", output: "ok" }); // settle so it never dangles
    await p;
  });

  it("PART B — a released looped step delivers its TYPED OBJECT output verbatim (not a stringified body)", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec({ loop: STEP_LOOP }), new AbortController().signal);
    await tick();

    // The /step-output route HOLDS a looped worker's first output — the join waits.
    const heldObject = { files: ["a.ts"], verified: true };
    let settled = false;
    void p.then(() => { settled = true; });
    stepOutput(bus, "w-1", { status: "done", output: heldObject, held: true });
    await tick();
    assert.equal(settled, false, "a held output must not resolve the workflow join");

    // Goal-met tick → daemon-style releaseReport republishes the STRUCTURED held
    // output (status "done", the typed object) — NOT the safeStringify'd heldReport text.
    const loop = loopRow({ heldReport: JSON.stringify(heldObject), heldOutput: { output: heldObject, status: "done" } });
    const tickResult = await runLoopTick(tickDeps(bus, loop), { workerId: "w-1" });
    assert.equal(tickResult, "released");

    const outcome = await p;
    assert.deepEqual(outcome.output, heldObject); // the OBJECT survives release, not a JSON string
    assert.notEqual(typeof outcome.output, "string");
    assert.equal(outcome.status, "done");
  });

  it("PART C — a held FAILED looped step releases as failed (status NOT inverted to done)", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec({ loop: STEP_LOOP }), new AbortController().signal);
    await tick();

    // A failed output, held under retryOnFailed. Its reason has no "failed:" prefix,
    // so the OLD text path's classifyReport(reason) would mis-classify it as done.
    const failedOutput = { error: "compilation broke" };
    stepOutput(bus, "w-1", { status: "failed", output: failedOutput, reason: "compilation broke", held: true });
    await tick();

    // Exhaust the loop (attempt limit) → releaseReport republishes the structured
    // held output verbatim: status stays "failed", reason + object preserved.
    const loop = loopRow({
      attempt: 1, maxAttempts: 1, heldReport: "compilation broke",
      heldOutput: { output: failedOutput, status: "failed", reason: "compilation broke" },
    });
    const tickResult = await runLoopTick(tickDeps(bus, loop, goalUnmet), { workerId: "w-1" });
    assert.equal(tickResult, "exhausted");

    const outcome = await p;
    assert.equal(outcome.status, "failed", "a released failed step must STAY failed, never invert to done");
    assert.equal(outcome.reason, "compilation broke");
    assert.deepEqual(outcome.output, failedOutput);
  });
});

describe("EventBusProgressSink", () => {
  it("publishes run/step lifecycle changes on the bus", () => {
    const bus = fakeBus();
    const sink = new EventBusProgressSink(bus as unknown as EventBus);
    sink.runChanged("run-1", "running");
    sink.stepChanged("run-1", "n1", "passed", "w-1");
    assert.deepEqual(bus.published, [
      { topic: "workflow:run-change", payload: { runId: "run-1", status: "running" } },
      { topic: "workflow:step-change", payload: { runId: "run-1", nodeId: "n1", status: "passed", workerId: "w-1" } },
    ]);
  });
});
