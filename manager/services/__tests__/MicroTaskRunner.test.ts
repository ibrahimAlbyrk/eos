import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MicroTaskRunner, type MicroTaskRunnerDeps, type MicroTaskRunConfig } from "../MicroTaskRunner.ts";
import type { MicroTask } from "../../../core/src/ports/MicroTask.ts";
import type { EventBus, EventBusMessage, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

// Drain the microtask queue so an async fire() chain (gate → extract → complete
// → apply) settles after a synchronous trigger or a mock-timer tick.
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fakeBus() {
  const subs = new Map<string, Set<EventBusSubscriber>>();
  const bus: EventBus = {
    publish(topic, payload) {
      const msg: EventBusMessage = { topic, payload, ts: 0 };
      for (const fn of [...(subs.get(topic) ?? []), ...(subs.get("*") ?? [])]) fn(msg);
    },
    subscribe(topic, fn) {
      const set = subs.get(topic) ?? new Set<EventBusSubscriber>();
      set.add(fn);
      subs.set(topic, set);
      return () => set.delete(fn);
    },
  };
  return bus;
}

interface SetupOpts {
  taskOver?: Partial<MicroTask>;
  enabled?: boolean;
  cfg?: Partial<MicroTaskRunConfig>;
  reply?: string;
  oneShotThrow?: boolean;
  pauseMaxMs?: number;
}

function setup(opts: SetupOpts = {}) {
  const clockState = { t: 0 };
  const bus = fakeBus();

  const oneShotCalls: Array<{ prompt: string; model?: string }> = [];
  const oneShot = {
    complete: async (prompt: string, o?: { model?: string }) => {
      oneShotCalls.push({ prompt, model: o?.model });
      if (opts.oneShotThrow) throw new Error("oneshot boom");
      return opts.reply ?? "auto name";
    },
  };

  const prompts = {
    render: (id: string) => `R:${id}`,
    renderInline: (body: string) => `I:${body}`,
  };

  const applied: string[] = [];
  const baseTask: MicroTask = {
    id: "t1",
    trigger: {
      topic: "worker:report",
      match: (p) => (p && typeof p === "object" ? ((p as { workerId?: string }).workerId ?? null) : null),
    },
    promptId: "micro-tasks/t1",
    gate: async () => true,
    extract: async () => ({ NAME: "x" }),
    apply: async (_ctx, out) => { applied.push(out); },
  };
  const task: MicroTask = { ...baseTask, ...opts.taskOver };

  const cfg: MicroTaskRunConfig = { enabled: true, delayMs: 100, model: "haiku", charLimit: 280, ...opts.cfg };
  let subsystem = opts.enabled ?? true;
  const pauseMaxMs = opts.pauseMaxMs ?? 1000;

  const deps: MicroTaskRunnerDeps = {
    bus,
    oneShot,
    prompts,
    clock: { now: () => clockState.t },
    log: noopLog,
    tasks: [task],
    subsystemEnabled: () => subsystem,
    configFor: () => cfg,
    pauseMaxMs: () => pauseMaxMs,
  };

  return {
    runner: new MicroTaskRunner(deps),
    bus,
    clockState,
    oneShotCalls,
    applied,
    setSubsystem: (v: boolean) => { subsystem = v; },
  };
}

describe("MicroTaskRunner", () => {
  it("arms on trigger, fires after the delay, runs extract → oneShot → apply", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup();
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    assert.equal(s.oneShotCalls.length, 0, "not fired before the delay");
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
    assert.equal(s.oneShotCalls[0].model, "haiku");
    assert.equal(s.oneShotCalls[0].prompt, "R:micro-tasks/t1");
    assert.deepEqual(s.applied, ["auto name"]);
  });

  it("promptTemplate override renders inline instead of the catalog prompt", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ cfg: { promptTemplate: "name: {{NAME}}" } });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls[0].prompt, "I:name: {{NAME}}");
  });

  it("ignores repeat triggers for the same entity (no double-arm, terminal after fire)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup();
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    s.bus.publish("worker:report", { workerId: "w1" }); // already scheduled → dropped
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
    s.bus.publish("worker:report", { workerId: "w1" }); // already fired (seen) → dropped
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
  });

  it("gate=false drops the run and marks it seen (gate not re-evaluated)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let gateCalls = 0;
    const s = setup({ taskOver: { gate: async () => { gateCalls++; return false; } } });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
    s.bus.publish("worker:report", { workerId: "w1" }); // seen short-circuits before gate
    await flush();
    assert.equal(gateCalls, 1, "seen blocks the second trigger before gate runs");
  });

  it("pause clears the timer and resume reschedules only the remaining time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ cfg: { delayMs: 100 } });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();                       // scheduled, deadline = now(0) + 100
    s.clockState.t = 40;                 // 40ms elapsed
    s.runner.pause("t1", "w1");          // remaining = 60; original timer cleared
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0, "cleared timer must not fire while paused");
    s.runner.resume("t1", "w1");         // reschedule the remaining 60ms
    t.mock.timers.tick(59);
    await flush();
    assert.equal(s.oneShotCalls.length, 0, "not yet — 1ms of the remaining 60 left");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
  });

  it("pause arriving before the trigger stores the run paused; resume then schedules it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ cfg: { delayMs: 100 } });
    s.runner.start();
    s.runner.pause("t1", "w1");          // sticky pause, no run yet
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();                       // gate passes → stored paused, NOT scheduled
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
    s.runner.resume("t1", "w1");
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
  });

  it("auto-resumes a paused run after pauseMaxMs (drop-safety, no explicit resume)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ cfg: { delayMs: 100 }, pauseMaxMs: 1000 });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    s.clockState.t = 40;
    s.runner.pause("t1", "w1");          // remaining 60, pause deadline 1000
    t.mock.timers.tick(1000);            // pauseMaxMs → auto resume → schedule(60)
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
    t.mock.timers.tick(60);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
  });

  it("cancel clears timers and is terminal (later triggers ignored)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup();
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    s.runner.cancel("t1", "w1", "test");
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
  });

  it("fail-closed when oneShot.complete throws (apply never runs, no crash)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ oneShotThrow: true });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 1);
    assert.equal(s.applied.length, 0);
  });

  it("fail-closed when apply throws (no crash)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ taskOver: { apply: async () => { throw new Error("apply boom"); } } });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 1); // reached the LLM; the apply error is swallowed
  });

  it("subsystem disabled → no arm", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ enabled: false });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
  });

  it("task disabled → not subscribed, no arm", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup({ cfg: { enabled: false } });
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
  });

  it("worker:exit clears a pending run for that entity", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup();
    s.runner.start();
    s.bus.publish("worker:report", { workerId: "w1" });
    await flush();
    s.bus.publish("worker:exit", { workerId: "w1" });
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.oneShotCalls.length, 0);
  });
});
