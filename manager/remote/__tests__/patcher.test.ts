// StatePatcher (§5.4.2 emission) — the regression suite for the "phone list
// state frozen at bootstrap" bug: worker/pending bus topics must fold into
// per-row patch frames (upsert with the GET-list row, remove with { id }),
// debounced per burst.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StatePatcher } from "../patcher.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "../WsBridge.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

class FakeBus implements EventBus {
  private subs = new Map<string, EventBusSubscriber[]>();
  publish(topic: EventBusTopic, payload: unknown): void {
    for (const fn of this.subs.get(topic) ?? []) fn({ topic, payload, ts: 0 });
  }
  subscribe(topic: EventBusTopic | "*", fn: EventBusSubscriber): () => void {
    const list = this.subs.get(topic) ?? [];
    list.push(fn);
    this.subs.set(topic, list);
    return () => { /* not needed in tests */ };
  }
}

function harness(routes: Record<string, unknown[]>) {
  const bus = new FakeBus();
  const bridge = new WsBridge({ bus, now: () => 0 });
  const sent: ServerFrame[] = [];
  const session: RemoteSession = { id: "dev-1", send: (f) => sent.push(f), close: () => {} };
  bridge.add(session);
  const patcher = new StatePatcher({
    bus, bridge, debounceMs: 5,
    routeDispatch: async ({ path }) => ({ status: 200, body: routes[path] ?? [] }),
  });
  patcher.start();
  return { bus, patcher, sent };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe("StatePatcher (workers/pending patch emission)", () => {
  it("emits an upsert patch with the full GET /workers row on worker:change", async () => {
    const row = { id: "w-1", state: "WORKING", name: "alpha" };
    const { bus, patcher, sent } = harness({ "/workers": [row] });
    bus.publish("worker:change", { workerId: "w-1" });
    await settle();
    const patches = sent.filter((f) => f.t === "patch");
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { t: "patch", seq: 1, resource: "workers", op: "upsert", data: row });
    patcher.stop();
  });

  it("emits a remove patch carrying { id } when the row left the active list", async () => {
    const { bus, patcher, sent } = harness({ "/workers": [] });
    bus.publish("worker:removed", { workerId: "w-gone" });
    await settle();
    const patches = sent.filter((f) => f.t === "patch");
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { t: "patch", seq: 1, resource: "workers", op: "remove", data: { id: "w-gone" } });
    patcher.stop();
  });

  it("coalesces a change burst for one worker into a single patch", async () => {
    const row = { id: "w-1", state: "WORKING" };
    const { bus, patcher, sent } = harness({ "/workers": [row] });
    for (let i = 0; i < 10; i++) bus.publish("worker:change", { workerId: "w-1" });
    await settle();
    assert.equal(sent.filter((f) => f.t === "patch").length, 1, "burst folds to one patch");
    patcher.stop();
  });

  it("upserts a pending row on pending:created", async () => {
    const pending = { id: "p-1", workerId: "w-1", toolName: "Bash" };
    const { bus, patcher, sent } = harness({ "/pending": [pending] });
    bus.publish("pending:created", { id: "p-1", workerId: "w-1" });
    await settle();
    const upsert = sent.find((f) => f.t === "patch");
    assert.deepEqual(upsert, { t: "patch", seq: 1, resource: "pending", op: "upsert", data: pending });
    patcher.stop();
  });

  it("emits remove for a resolved pending that left the list", async () => {
    const { bus, patcher, sent } = harness({ "/pending": [] });
    bus.publish("pending:resolved", { id: "p-1", behavior: "allow" });
    await settle();
    const patches = sent.filter((f) => f.t === "patch");
    assert.deepEqual(patches[0], { t: "patch", seq: 1, resource: "pending", op: "remove", data: { id: "p-1" } });
    patcher.stop();
  });

  it("stays silent with no live sessions", async () => {
    const bus = new FakeBus();
    const bridge = new WsBridge({ bus, now: () => 0 });
    let dispatched = 0;
    const patcher = new StatePatcher({
      bus, bridge, debounceMs: 5,
      routeDispatch: async () => { dispatched++; return { status: 200, body: [] }; },
    });
    patcher.start();
    bus.publish("worker:change", { workerId: "w-1" });
    await settle();
    assert.equal(dispatched, 0, "no list read when nobody is connected");
    patcher.stop();
  });
});
