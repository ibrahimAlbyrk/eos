import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { PendingPeerRequestService } from "../PendingPeerRequestService.ts";

function wrow(p: Partial<WorkerRow> & { id: string }): WorkerRow {
  return {
    id: p.id, state: p.state ?? "IDLE", cwd: null, worktree_from: null, branch: null,
    prompt: "do", name: p.name ?? null, pid: null, port: 1, started_at: 0, ended_at: null,
    exit_code: null, parent_id: p.parent_id ?? null, collaborate: p.collaborate ?? null,
  } as WorkerRow;
}

function wrepo(rows: WorkerRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    findById: (id: string) => byId.get(id) ?? null,
    listByParent: (pid: string) => rows.filter((r) => r.parent_id === pid),
  };
}

class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  newWorkerId(): string { return `worker-${++this.counter}`; }
  newOrchestratorId(): string { return `orch-${++this.counter}`; }
  newPendingId(): string { return `pending-${++this.counter}`; }
  newRequestId(): string { return `req-${++this.counter}`; }
}

class FakeClock implements Clock {
  t = 0;
  now(): number { return this.t; }
}

const GRACE_MS = 5 * 60 * 1000;

describe("PendingPeerRequestService", () => {
  let svc: PendingPeerRequestService;
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
    svc = new PendingPeerRequestService(new FakeIdGenerator(), clock);
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

  it("a terminal answer survives repeated polls (lost-response retry safety)", () => {
    const { requestId } = svc.register("A", "B", "q?");
    svc.markDelivered(requestId);
    svc.resolveDelivered("B", "the answer");
    // ask_peer retries on a transient GET failure; the answer must persist.
    assert.deepEqual(svc.poll(requestId), { status: "answered", answer: "the answer" });
    assert.deepEqual(svc.poll(requestId), { status: "answered", answer: "the answer" });
  });

  it("a terminal entry is pruned after the grace window; a pending one is not", () => {
    const answered = svc.register("A", "B", "q?").requestId;
    const pending = svc.register("C", "B", "still waiting").requestId;
    svc.markDelivered(answered);
    svc.resolveDelivered("B", "done");

    clock.t = GRACE_MS - 1; // within grace: still readable
    assert.equal(svc.poll(answered).status, "answered");

    clock.t = GRACE_MS + 1; // past grace: reclaimed; pending untouched
    assert.deepEqual(svc.poll(answered), { status: "gone" });
    assert.deepEqual(svc.poll(pending), { status: "pending" });
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

  it("an awaiting consult parks as pending and is not deliverable until bound", () => {
    const { requestId } = svc.registerAwaiting("A", "P", { name: "prov" }, "need the schema");
    assert.deepEqual(svc.poll(requestId), { status: "pending" });
    assert.equal(svc.nextQueuedFor("B"), null); // no target bound yet
  });

  it("tryBind binds an awaiting consult to a newly-arrived peer (→ queued, deliverable)", () => {
    const { requestId } = svc.registerAwaiting("A", "P", { name: "prov" }, "need the schema");
    const workers = wrepo([
      wrow({ id: "A", name: "consumer", parent_id: "P", collaborate: 1 }),
      wrow({ id: "B", name: "prov", parent_id: "P", collaborate: 1, state: "IDLE" }),
    ]);
    assert.deepEqual(svc.tryBind("P", workers), ["B"]);
    assert.equal(svc.nextQueuedFor("B")?.requestId, requestId);
    assert.deepEqual(svc.poll(requestId), { status: "pending" }); // pending until answered
  });

  it("consumer-before-provider: parks, binds on the provider's arrival, then delivers + answers", () => {
    const { requestId } = svc.registerAwaiting("C", "P", { name: "schema-owner" }, "what columns?");
    // Provider not spawned yet — tryBind leaves it awaiting.
    const before = wrepo([wrow({ id: "C", name: "consumer", parent_id: "P", collaborate: 1 })]);
    assert.deepEqual(svc.tryBind("P", before), []);
    assert.deepEqual(svc.poll(requestId), { status: "pending" });
    // Provider arrives → bind, deliver, answer.
    const after = wrepo([
      wrow({ id: "C", name: "consumer", parent_id: "P", collaborate: 1 }),
      wrow({ id: "S", name: "schema-owner", parent_id: "P", collaborate: 1, state: "IDLE" }),
    ]);
    assert.deepEqual(svc.tryBind("P", after), ["S"]);
    assert.equal(svc.nextQueuedFor("S")?.requestId, requestId);
    svc.markDelivered(requestId);
    assert.deepEqual(svc.resolveDelivered("S", "id, name, ts"), { requestId, from: "C" });
    assert.deepEqual(svc.poll(requestId), { status: "answered", answer: "id, name, ts" });
  });

  it("an awaiting consult declines once its wait window expires", () => {
    const local = new PendingPeerRequestService(new FakeIdGenerator(), clock, 1000);
    const { requestId } = local.registerAwaiting("A", "P", { name: "never" }, "q");
    clock.t = 999;
    assert.deepEqual(local.poll(requestId), { status: "pending" }); // within window
    clock.t = 1000;
    assert.equal(local.poll(requestId).status, "declined"); // deadline reached
  });

  it("tryBind declines an awaiting consult that would close a cycle at bind time", () => {
    svc.register("B", "A", "b asks a"); // B already waits on A (B→A edge)
    const { requestId } = svc.registerAwaiting("A", "P", { id: "B" }, "a asks b");
    const workers = wrepo([
      wrow({ id: "A", name: "a", parent_id: "P", collaborate: 1 }),
      wrow({ id: "B", name: "b", parent_id: "P", collaborate: 1, state: "IDLE" }),
    ]);
    assert.deepEqual(svc.tryBind("P", workers), []); // binding A→B would close B→A→B, so not bound
    assert.equal(svc.poll(requestId).status, "declined");
  });
});
