import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fireScheduledPrompts, type ScheduledDispatchInput } from "../use-cases/FireScheduledPrompts.ts";
import type { ScheduledPromptRepo, ScheduledPromptRow, InsertScheduledPrompt } from "../ports/ScheduledPromptRepo.ts";

// In-memory repo mirroring the SQLite adapter's semantics: listDue = pending
// rows with fire_at <= now, markFired flips status + stamps meta, cancel only
// touches pending rows.
class FakeRepo implements ScheduledPromptRepo {
  rows = new Map<string, ScheduledPromptRow>();
  insert(input: InsertScheduledPrompt): ScheduledPromptRow {
    const row: ScheduledPromptRow = { ...input, status: "pending", firedAt: null, meta: null };
    this.rows.set(row.id, row);
    return row;
  }
  findById(id: string): ScheduledPromptRow | null { return this.rows.get(id) ?? null; }
  listByWorker(workerId: string): ScheduledPromptRow[] {
    return [...this.rows.values()].filter((r) => r.workerId === workerId);
  }
  listDue(now: number): ScheduledPromptRow[] {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" && r.fireAt <= now)
      .sort((a, b) => a.fireAt - b.fireAt);
  }
  markFired(id: string, firedAt: number, meta: Record<string, unknown> | null): void {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, status: "fired", firedAt, meta });
  }
  cancel(id: string): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== "pending") return false;
    this.rows.set(id, { ...r, status: "cancelled" });
    return true;
  }
}

function seed(repo: FakeRepo, id: string, fireAt: number): void {
  repo.insert({ id, workerId: "orch-1", text: `t-${id}`, fireAt, createdAt: 0 });
}

describe("fireScheduledPrompts", () => {
  it("dispatches due pending rows, marks them fired, and skips non-due rows", async () => {
    const repo = new FakeRepo();
    seed(repo, "a", 1000); // due at now=5000
    seed(repo, "b", 4999); // due
    seed(repo, "c", 6000); // not due
    const calls: ScheduledDispatchInput[] = [];
    const fired = await fireScheduledPrompts({
      repo,
      clock: { now: () => 5000 },
      dispatch: async (input) => { calls.push(input); return { status: 202, body: {} }; },
    });

    assert.equal(fired, 2);
    assert.deepEqual(calls.map((c) => c.workerId), ["orch-1", "orch-1"]);
    // Idempotency key + origin + queueWhenBusy per the contract.
    assert.deepEqual(calls.map((c) => c.clientMsgId).sort(), ["sched-a", "sched-b"]);
    assert.ok(calls.every((c) => c.origin === "scheduled" && c.queueWhenBusy === true));
    assert.equal(repo.findById("a")!.status, "fired");
    assert.equal(repo.findById("b")!.status, "fired");
    assert.equal(repo.findById("c")!.status, "pending");
  });

  it("flags meta.late when fired more than 60s after fireAt", async () => {
    const repo = new FakeRepo();
    seed(repo, "late", 1000);   // fired at now=70000 → 69s late
    seed(repo, "ontime", 69999); // fired at now=70000 → 1ms late
    await fireScheduledPrompts({
      repo,
      clock: { now: () => 70_000 },
      dispatch: async () => ({ status: 202, body: {} }),
    });
    assert.deepEqual(repo.findById("late")!.meta, { late: true });
    assert.equal(repo.findById("ontime")!.meta, null);
  });

  it("leaves a row pending when dispatch throws (retried next tick)", async () => {
    const repo = new FakeRepo();
    seed(repo, "x", 1000);
    const fired = await fireScheduledPrompts({
      repo,
      clock: { now: () => 5000 },
      dispatch: async () => { throw new Error("worker unreachable"); },
    });
    assert.equal(fired, 0);
    assert.equal(repo.findById("x")!.status, "pending");
  });

  it("invokes onFired with the fired row for the timeline event", async () => {
    const repo = new FakeRepo();
    seed(repo, "e", 1000);
    const seen: ScheduledPromptRow[] = [];
    await fireScheduledPrompts({
      repo,
      clock: { now: () => 5000 },
      dispatch: async () => ({ status: 202, body: {} }),
      onFired: (row) => seen.push(row),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "e");
    assert.equal(seen[0].status, "fired");
    assert.equal(seen[0].firedAt, 5000);
  });
});
