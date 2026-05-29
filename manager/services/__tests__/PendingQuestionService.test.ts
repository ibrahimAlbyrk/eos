import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";
import { PendingQuestionService } from "../PendingQuestionService.ts";

class FakeClock implements Clock {
  current = 1000;
  now(): number {
    return this.current;
  }
}

class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  newWorkerId(): string {
    return `worker-${++this.counter}`;
  }
  newOrchestratorId(): string {
    return `orch-${++this.counter}`;
  }
  newPendingId(): string {
    return `pending-${++this.counter}`;
  }
  newRequestId(): string {
    return `request-${++this.counter}`;
  }
}

describe("PendingQuestionService", () => {
  let clock: FakeClock;
  let ids: FakeIdGenerator;
  let svc: PendingQuestionService;

  beforeEach(() => {
    clock = new FakeClock();
    ids = new FakeIdGenerator();
    svc = new PendingQuestionService(clock, ids, 5000);
  });

  it("register returns a deterministic questionId and a promise", () => {
    const { questionId, promise } = svc.register("w1");
    assert.equal(questionId, "pending-1");
    assert.ok(promise instanceof Promise);
  });

  it("resolve settles the matching promise with answers and returns true", async () => {
    const { questionId, promise } = svc.register("w1");
    const answers = { name: "Eos" };
    const ok = svc.resolve(questionId, answers);
    assert.equal(ok, true);
    assert.deepEqual(await promise, answers);
  });

  it("resolve(unknownId) returns false", () => {
    assert.equal(svc.resolve("nope", { a: "b" }), false);
  });

  it("resolving the same id twice returns false on the second call", async () => {
    const { questionId, promise } = svc.register("w1");
    assert.equal(svc.resolve(questionId, { a: "1" }), true);
    assert.equal(svc.resolve(questionId, { a: "2" }), false);
    assert.deepEqual(await promise, { a: "1" });
  });

  it("reject settles the matching promise with the given error and returns true", async () => {
    const { questionId, promise } = svc.register("w1");
    const err = new Error("boom");
    assert.equal(svc.reject(questionId, err), true);
    await assert.rejects(promise, /boom/);
  });

  it("reject(unknownId) returns false", () => {
    assert.equal(svc.reject("nope", new Error("x")), false);
  });

  it("resolveByWorker resolves the worker's current pending question", async () => {
    const { promise } = svc.register("w1");
    const answers = { picked: "yes" };
    assert.equal(svc.resolveByWorker("w1", answers), true);
    assert.deepEqual(await promise, answers);
  });

  it("resolveByWorker returns false for a worker with no pending question", () => {
    assert.equal(svc.resolveByWorker("ghost", { a: "b" }), false);
  });

  it("a second register for the same worker rejects the first promise (supersede)", async () => {
    const first = svc.register("w1");
    const second = svc.register("w1");

    assert.notEqual(first.questionId, second.questionId);
    await assert.rejects(first.promise, /superseded/);

    // The new question is the one tracked for the worker now.
    const answers = { only: "new" };
    assert.equal(svc.resolveByWorker("w1", answers), true);
    assert.deepEqual(await second.promise, answers);

    // The superseded id is gone, not still resolvable.
    assert.equal(svc.resolve(first.questionId, { stale: "1" }), false);
  });

  it("sweepExpired rejects and drops entries past the TTL", async () => {
    const { questionId, promise } = svc.register("w1"); // expiresAt = 1000 + 5000

    // Before expiry: nothing swept, still resolvable.
    svc.sweepExpired(clock.now());
    assert.equal(svc.resolve(questionId, { still: "here" }), true);
    assert.deepEqual(await promise, { still: "here" });

    // A fresh entry, then advance past its TTL.
    const second = svc.register("w2"); // expiresAt = 1000 + 5000 = 6000
    svc.sweepExpired(6001);
    await assert.rejects(second.promise, /expired/);

    // Dropped: no longer resolvable, and the worker mapping is cleared.
    assert.equal(svc.resolve(second.questionId, { late: "1" }), false);
    assert.equal(svc.resolveByWorker("w2", { late: "1" }), false);
  });
});
