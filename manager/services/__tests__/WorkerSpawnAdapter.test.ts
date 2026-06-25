import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkerSpawnAdapter } from "../WorkerSpawnAdapter.ts";
import { EventBusProgressSink } from "../EventBusProgressSink.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";

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

function makeAdapter() {
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
  };
  const adapter = new WorkerSpawnAdapter(deps as never);
  return { adapter, bus, steps, inserted, killed, spawned };
}

const stepSpec = (over: Record<string, unknown> = {}) => ({
  runId: "run-1", nodeId: "n1", parentId: "anchor-1",
  prompt: "do the thing", mode: "acceptEdits", collaborate: true, ...over,
}) as never;

describe("WorkerSpawnAdapter — spawn-join", () => {
  it("resolves a step from a released worker:report (text-fallback path)", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    bus.publish("worker:report", { workerId: "w-1", text: "result: shipped" });
    const outcome = await p;
    assert.equal(outcome.workerId, "w-1");
    assert.equal(outcome.reportText, "result: shipped");
    assert.equal(outcome.signal, "result");
  });

  it("stamps the step-worker id onto the running row at spawn (§3.7 recovery key)", async () => {
    const { adapter, bus, steps } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick(); // let runSpawn resolve + the stamp + the join register
    // The id is durably linked to the node BEFORE any report — so a crash in the
    // await window leaves a `running` row the boot re-arm can match + recover.
    assert.equal(steps.rows.get(steps.key("run-1", "n1"))?.workerId, "w-1");
    bus.publish("worker:report", { workerId: "w-1", text: "result: ok" }); // settle so the promise never dangles
    await p;
  });

  it("ignores a held report and settles on the later released report", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    let settled = false;
    void p.then(() => { settled = true; });
    bus.publish("worker:report", { workerId: "w-1", held: true, text: "result: premature" });
    await tick();
    assert.equal(settled, false, "a held report must not settle the join");
    bus.publish("worker:report", { workerId: "w-1", text: "result: verified" });
    const outcome = await p;
    assert.equal(outcome.reportText, "result: verified");
  });

  it("rejects when a worker exits before reporting (crash)", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    bus.publish("worker:exit", { workerId: "w-1" });
    await assert.rejects(p, /exited before reporting/);
  });

  it("does NOT reject on exit after a (held) report was seen", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    let outcome: unknown = "pending";
    void p.then((o) => { outcome = o; }, (e) => { outcome = e; });
    bus.publish("worker:report", { workerId: "w-1", held: true, text: "held" });
    bus.publish("worker:exit", { workerId: "w-1" });
    await tick();
    assert.equal(outcome, "pending", "a reported-then-exited worker keeps waiting for the release");
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
    bus.publish("worker:report", { workerId: "w-1", text: "result: ok" });
    assert.equal((await p).signal, "result");
  });

  it("first settle wins (resolve-once) across exit then report", async () => {
    const { adapter, bus } = makeAdapter();
    const p = adapter.spawnAndAwait(stepSpec(), new AbortController().signal);
    await tick();
    bus.publish("worker:exit", { workerId: "w-1" }); // first settle = reject
    bus.publish("worker:report", { workerId: "w-1", text: "result: late" }); // ignored
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
    bus.publish("worker:report", { workerId: "w-1", text: "result: ok" });
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
