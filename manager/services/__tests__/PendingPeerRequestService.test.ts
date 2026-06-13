import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";
import { PendingPeerRequestService } from "../PendingPeerRequestService.ts";

class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  newWorkerId(): string { return `worker-${++this.counter}`; }
  newOrchestratorId(): string { return `orch-${++this.counter}`; }
  newPendingId(): string { return `pending-${++this.counter}`; }
  newRequestId(): string { return `req-${++this.counter}`; }
}

describe("PendingPeerRequestService", () => {
  let svc: PendingPeerRequestService;

  beforeEach(() => {
    svc = new PendingPeerRequestService(new FakeIdGenerator());
  });

  it("register → poll pending; unknown id → gone", () => {
    const { requestId } = svc.register("A", "B", "q?");
    assert.deepEqual(svc.poll(requestId), { status: "pending" });
    assert.deepEqual(svc.poll("nope"), { status: "gone" });
  });

  it("deliver then resolve → asker poll sees the answer", () => {
    const { requestId } = svc.register("A", "B", "q?");
    assert.equal(svc.nextQueuedFor("B")?.requestId, requestId);
    svc.markDelivered(requestId);
    assert.deepEqual(svc.poll(requestId), { status: "pending" }); // delivered still reads pending
    const resolved = svc.resolveDelivered("B", "the answer");
    assert.deepEqual(resolved, { requestId, from: "A" });
    assert.deepEqual(svc.poll(requestId), { status: "answered", answer: "the answer" });
  });

  it("declineDelivered settles a delivered request; no-op when already answered", () => {
    const { requestId } = svc.register("A", "B", "q?");
    svc.markDelivered(requestId);
    assert.equal(svc.declineDelivered("B", "ended turn"), true);
    assert.deepEqual(svc.poll(requestId), { status: "declined", reason: "ended turn" });
    // already terminal → cannot be re-declined
    assert.equal(svc.declineDelivered("B", "again"), false);
  });

  it("nextQueuedFor is FIFO and skips the delivered one", () => {
    const r1 = svc.register("A", "B", "first").requestId;
    const r2 = svc.register("C", "B", "second").requestId;
    assert.equal(svc.nextQueuedFor("B")?.requestId, r1);
    svc.markDelivered(r1);
    assert.equal(svc.nextQueuedFor("B")?.requestId, r2); // r1 delivered → next is r2
  });

  it("resolveDelivered returns null when nothing is in flight", () => {
    svc.register("A", "B", "q?"); // queued, not delivered
    assert.equal(svc.resolveDelivered("B", "x"), null);
  });

  it("cancelByWorker: outbound dropped, inbound goes gone", () => {
    const out = svc.register("A", "B", "A asks B").requestId;
    const inn = svc.register("C", "A", "C asks A").requestId;
    svc.cancelByWorker("A");
    assert.deepEqual(svc.poll(out), { status: "gone" }); // A's outbound removed
    assert.deepEqual(svc.poll(inn), { status: "gone" }); // inbound to A → gone (asker C unblocks)
  });

  it("wouldDeadlock detects a direct mutual cycle", () => {
    svc.register("A", "B", "A waits on B");
    // B answering A now wants to ask A → would close the cycle.
    assert.equal(svc.wouldDeadlock("B", "A"), true);
    // An unrelated consult does not.
    assert.equal(svc.wouldDeadlock("B", "C"), false);
  });

  it("wouldDeadlock detects a transitive cycle (A→B→C→A)", () => {
    svc.register("A", "B", "");
    svc.register("B", "C", "");
    assert.equal(svc.wouldDeadlock("C", "A"), true);
    assert.equal(svc.wouldDeadlock("C", "D"), false);
  });
});
