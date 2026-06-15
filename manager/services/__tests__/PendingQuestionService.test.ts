import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import { PendingQuestionService } from "../PendingQuestionService.ts";

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

class FakeClock implements Clock {
  t = 0;
  now(): number { return this.t; }
}

const GRACE_MS = 5 * 60 * 1000;

describe("PendingQuestionService", () => {
  let svc: PendingQuestionService;
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
    svc = new PendingQuestionService(new FakeIdGenerator(), clock);
  });

  it("register returns a deterministic questionId; poll sees pending", () => {
    const { questionId } = svc.register("w1", "tuA");
    assert.equal(questionId, "pending-1");
    assert.deepEqual(svc.poll(questionId), { status: "pending" });
  });

  it("poll(unknownId) reports gone", () => {
    assert.deepEqual(svc.poll("nope"), { status: "gone" });
  });

  it("resolveByToolUseId settles to answered with the answers", () => {
    const { questionId } = svc.register("w1", "tuA");
    const answers = { name: "Eos" };
    assert.equal(svc.resolveByToolUseId("w1", "tuA", answers), true);
    assert.deepEqual(svc.poll(questionId), { status: "answered", answers });
  });

  it("a terminal state survives repeated polls (lost-response retry safety)", () => {
    const { questionId } = svc.register("w1", "tuA");
    svc.resolveByToolUseId("w1", "tuA", { a: "1" });
    assert.equal(svc.poll(questionId).status, "answered");
    assert.equal(svc.poll(questionId).status, "answered");
  });

  it("dismissByToolUseId settles to dismissed", () => {
    const { questionId } = svc.register("w1", "tuA");
    assert.equal(svc.dismissByToolUseId("w1", "tuA"), true);
    assert.deepEqual(svc.poll(questionId), { status: "dismissed" });
  });

  it("settling an already-terminal question returns false and keeps the first state", () => {
    const { questionId } = svc.register("w1", "tuA");
    assert.equal(svc.resolveByToolUseId("w1", "tuA", { a: "1" }), true);
    assert.equal(svc.resolveByToolUseId("w1", "tuA", { a: "2" }), false);
    assert.equal(svc.dismissByToolUseId("w1", "tuA"), false);
    assert.deepEqual(svc.poll(questionId), { status: "answered", answers: { a: "1" } });
  });

  it("resolveByToolUseId returns false for an unknown (worker, toolUseId)", () => {
    svc.register("w1", "tuA");
    assert.equal(svc.resolveByToolUseId("w1", "ghost", { a: "b" }), false);
    assert.equal(svc.resolveByToolUseId("w2", "tuA", { a: "b" }), false);
  });

  it("two concurrent questions for the same worker coexist (no supersede)", () => {
    const a = svc.register("w1", "tuA");
    const b = svc.register("w1", "tuB");
    assert.notEqual(a.questionId, b.questionId);

    assert.equal(svc.resolveByToolUseId("w1", "tuA", { picked: "yes" }), true);
    assert.deepEqual(svc.poll(a.questionId), { status: "answered", answers: { picked: "yes" } });
    assert.deepEqual(svc.poll(b.questionId), { status: "pending" });
  });

  it("a re-register of the SAME (worker, toolUseId) supersedes the prior", () => {
    const first = svc.register("w1", "tuA");
    const second = svc.register("w1", "tuA");

    assert.notEqual(first.questionId, second.questionId);
    assert.deepEqual(svc.poll(first.questionId), { status: "gone" });

    assert.equal(svc.resolveByToolUseId("w1", "tuA", { only: "new" }), true);
    assert.deepEqual(svc.poll(second.questionId), { status: "answered", answers: { only: "new" } });
  });

  it("a terminal entry is pruned after the grace window; a pending one is not", () => {
    const answered = svc.register("w1", "tuA");
    const stillPending = svc.register("w1", "tuB");
    svc.resolveByToolUseId("w1", "tuA", { a: "1" });

    // Within grace: a late poll still reads the answer (lost-response safety).
    clock.t = GRACE_MS - 1;
    assert.equal(svc.poll(answered.questionId).status, "answered");

    // Past grace: the terminal entry is reclaimed, the pending one survives.
    clock.t = GRACE_MS + 1;
    assert.deepEqual(svc.poll(answered.questionId), { status: "gone" });
    assert.deepEqual(svc.poll(stillPending.questionId), { status: "pending" });
  });

  it("cancelByWorker drops every entry for that worker, terminal or not", () => {
    const a = svc.register("w1", "tuA");
    const b = svc.register("w1", "tuB");
    const other = svc.register("w2", "tuC");
    svc.resolveByToolUseId("w1", "tuB", { done: "1" });

    svc.cancelByWorker("w1");

    assert.deepEqual(svc.poll(a.questionId), { status: "gone" });
    assert.deepEqual(svc.poll(b.questionId), { status: "gone" });
    assert.deepEqual(svc.poll(other.questionId), { status: "pending" });
    assert.equal(svc.resolveByToolUseId("w2", "tuC", { still: "here" }), true);
  });
});
