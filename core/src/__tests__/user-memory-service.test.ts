import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StaleMemoryError, UserMemoryService } from "../services/UserMemoryService.ts";
import { LimitExceededError, NotFoundError, ValidationError } from "../errors/index.ts";
import type { UserMemory, UserMemorySource } from "../../../contracts/src/profile.ts";

const AGENT: UserMemorySource = { kind: "agent", agentId: "w-1", agentName: "find-bar" };
const OTHER: UserMemorySource = { kind: "agent", agentId: "w-2", agentName: "stream" };

function make(maxPendingPerProducer?: number) {
  const store = new Map<string, UserMemory>();
  const events: { action: string; status: string; by: string }[] = [];
  let n = 0;
  let now = 1000;
  const svc = new UserMemoryService({
    store: {
      list: () => [...store.values()],
      get: (id) => store.get(id) ?? null,
      put: (m) => { store.set(m.id, m); },
      remove: (id) => store.delete(id),
    },
    clock: { now: () => (now += 1) },
    bus: { publish: (_t, p) => { events.push(p as { action: string; status: string; by: string }); } },
    newId: () => `um-test${String(++n).padStart(4, "0")}`,
    maxPendingPerProducer,
  });
  return { svc, store, events };
}

describe("UserMemoryService", () => {
  it("an agent's suggestion waits for the user, always-on by default", () => {
    const { svc, events } = make();
    const { memory, duplicate } = svc.suggest({ text: "  Prefers   pnpm. ", category: "stack", scope: { kind: "global" } }, AGENT);
    assert.equal(duplicate, false);
    assert.equal(memory.status, "suggested");
    assert.equal(memory.tier, "always");
    assert.equal(memory.text, "Prefers pnpm.");
    assert.deepEqual(events, [{ id: memory.id, action: "created", status: "suggested", by: "agent" }]);
  });

  it("a duplicate returns the existing memory instead of piling up", () => {
    const { svc, store } = make();
    const kept = svc.create({ text: "Write commits in English.", category: "work-style", scope: { kind: "global" }, tier: "always" });
    const r = svc.suggest({ text: "write commits in english", category: "work-style", scope: { kind: "project", path: "/x" } }, AGENT);
    assert.ok(r.duplicate);
    assert.equal(r.memory.id, kept.id);
    assert.equal(store.size, 1);
  });

  it("caps pending suggestions per producer, not globally", () => {
    const { svc } = make(2);
    svc.suggest({ text: "alpha beta", category: "other", scope: { kind: "global" } }, AGENT);
    svc.suggest({ text: "gamma delta", category: "other", scope: { kind: "global" } }, AGENT);
    assert.throws(() => svc.suggest({ text: "epsilon zeta", category: "other", scope: { kind: "global" } }, AGENT), LimitExceededError);
    assert.doesNotThrow(() => svc.suggest({ text: "eta theta", category: "other", scope: { kind: "global" } }, OTHER));
  });

  it("approve keeps it; dismiss removes a pending one but refuses a kept one", () => {
    const { svc, store, events } = make();
    const a = svc.suggest({ text: "one two", category: "other", scope: { kind: "global" } }, AGENT).memory;
    const b = svc.suggest({ text: "three four", category: "other", scope: { kind: "global" } }, AGENT).memory;
    const kept = svc.approve(a.id);
    assert.equal(kept.status, "active");
    assert.equal(kept.rev, 1);
    assert.equal(svc.approve(a.id).rev, 1); // idempotent
    svc.dismiss(b.id);
    assert.ok(!store.has(b.id));
    assert.throws(() => svc.dismiss(a.id), ValidationError);
    assert.deepEqual(events.slice(-2).map((e) => e.action), ["approved", "dismissed"]);
  });

  it("approveAll keeps every pending suggestion", () => {
    const { svc } = make();
    svc.suggest({ text: "one two", category: "other", scope: { kind: "global" } }, AGENT);
    svc.suggest({ text: "three four", category: "other", scope: { kind: "global" } }, OTHER);
    assert.equal(svc.approveAll().length, 2);
    assert.ok(svc.list().every((m) => m.status === "active"));
  });

  it("update: stale baseRev refused, no-op keeps rev, text normalized", () => {
    const { svc } = make();
    const m = svc.create({ text: "Use tabs.", category: "work-style", scope: { kind: "global" }, tier: "always" });
    const next = svc.update(m.id, { text: "  Use   spaces. ", tier: "on-demand" }, 0);
    assert.equal(next.text, "Use spaces.");
    assert.equal(next.rev, 1);
    assert.equal(svc.update(m.id, { tier: "on-demand" }).rev, 1);
    assert.throws(() => svc.update(m.id, { text: "x" }, 0), StaleMemoryError);
  });

  it("unknown ids are NotFound", () => {
    const { svc } = make();
    assert.throws(() => svc.approve("um-nope0000"), NotFoundError);
    assert.throws(() => svc.remove("um-nope0000"), NotFoundError);
  });

  it("search sees only kept memories in scope", () => {
    const { svc } = make();
    svc.create({ text: "Prefers pnpm.", category: "stack", scope: { kind: "global" }, tier: "on-demand" });
    svc.suggest({ text: "Pending pnpm thing.", category: "stack", scope: { kind: "global" } }, AGENT);
    assert.deepEqual(svc.search("pnpm", null, 5).map((m) => m.text), ["Prefers pnpm."]);
  });
});
