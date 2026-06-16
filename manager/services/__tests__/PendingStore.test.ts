import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import { PendingStore, TERMINAL_GRACE_MS } from "../PendingStore.ts";

class FakeClock implements Clock {
  t = 0;
  now(): number { return this.t; }
}

type S = { status: "pending" } | { status: "done"; v: number };

describe("PendingStore", () => {
  let clock: FakeClock;
  let store: PendingStore<S, { owner: string }>;

  beforeEach(() => {
    clock = new FakeClock();
    store = new PendingStore<S, { owner: string }>(clock);
  });

  it("add → get returns the entry; pending while unsettled", () => {
    store.add("a", { status: "pending" }, { owner: "w1" });
    const e = store.get("a");
    assert.ok(e);
    assert.equal(store.isPending(e), true);
    assert.deepEqual(e.state, { status: "pending" });
    assert.deepEqual(e.meta, { owner: "w1" });
  });

  it("settle moves to terminal once; a second settle is a no-op (first wins)", () => {
    store.add("a", { status: "pending" }, { owner: "w1" });
    assert.equal(store.settle("a", { status: "done", v: 1 }), true);
    assert.equal(store.settle("a", { status: "done", v: 2 }), false);
    assert.deepEqual(store.get("a")?.state, { status: "done", v: 1 });
    assert.equal(store.isPending(store.get("a")!), false);
  });

  it("settle on an unknown id returns false", () => {
    assert.equal(store.settle("ghost", { status: "done", v: 1 }), false);
  });

  it("transition changes a pending state without settling; refuses once terminal", () => {
    store.add("a", { status: "pending" }, { owner: "w1" });
    assert.equal(store.transition("a", { status: "pending" }), true);
    assert.equal(store.isPending(store.get("a")!), true);
    store.settle("a", { status: "done", v: 1 });
    assert.equal(store.transition("a", { status: "pending" }), false);
  });

  it("sweep reclaims terminal entries past the grace window; never pending ones", () => {
    store.add("term", { status: "pending" }, { owner: "w1" });
    store.add("pend", { status: "pending" }, { owner: "w1" });
    store.settle("term", { status: "done", v: 1 }); // settledAt = 0

    clock.t = TERMINAL_GRACE_MS - 1;
    store.sweep();
    assert.ok(store.get("term"), "within grace: terminal still present");

    clock.t = TERMINAL_GRACE_MS + 1;
    store.sweep();
    assert.equal(store.get("term"), undefined, "past grace: terminal reclaimed");
    assert.ok(store.get("pend"), "pending is immortal");
  });

  it("delete removes immediately", () => {
    store.add("a", { status: "pending" }, { owner: "w1" });
    store.delete("a");
    assert.equal(store.get("a"), undefined);
  });
});
