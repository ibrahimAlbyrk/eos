import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DREAM_PENDING_CAP, StaleMemoryError, UserMemoryService } from "../services/UserMemoryService.ts";
import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "../errors/index.ts";
import type { UserMemory, UserMemorySource } from "../../../contracts/src/profile.ts";

const AGENT: UserMemorySource = { kind: "agent", agentId: "w-1", agentName: "find-bar" };
const DREAM: UserMemorySource = { kind: "dream", dreamId: "dr-1", evidence: [] };
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
    assert.equal(store.get(b.id)?.status, "dismissed"); // a tombstone, not gone
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

  it("a dismissed idea is declined, by agents and dreams alike", () => {
    const { svc } = make();
    const m = svc.suggest({ text: "Prefers tabs over spaces.", category: "work-style", scope: { kind: "global" } }, AGENT).memory;
    svc.dismiss(m.id);
    const again = svc.suggest({ text: "prefers tabs over spaces", category: "work-style", scope: { kind: "global" } }, DREAM);
    assert.deepEqual([again.duplicate, again.declined, again.memory.id], [true, true, m.id]);
    assert.equal(svc.search("tabs", null, 5).length, 0);
  });

  it("all dreams share one morning budget, apart from the agents'", () => {
    const { svc } = make(2);
    const idea = (i: number) => ({ text: `distinct idea number ${i} about ${"xyz".repeat(i + 1)}`, category: "other" as const, scope: { kind: "global" as const } });
    for (let i = 0; i < DREAM_PENDING_CAP; i++) svc.suggest(idea(i), { ...DREAM, dreamId: `dr-${i}` });
    assert.throws(() => svc.suggest(idea(9), { ...DREAM, dreamId: "dr-other-mac" }), LimitExceededError);
    svc.suggest(idea(10), { kind: "agent", agentId: "w-1", agentName: "a" });
    assert.equal(svc.list().filter((m) => m.status === "suggested").length, DREAM_PENDING_CAP + 1);
  });

  it("a domain is stored when given and carried by an update proposal", () => {
    const { svc, store } = make();
    const t = svc.create({ text: "When committing, split changes.", category: "work-style", scope: { kind: "global" }, tier: "always" });
    assert.ok(!("domain" in store.get(t.id)!));
    const p = svc.suggest({ text: "When committing, review the diff and split changes.", category: "work-style", domain: "git", scope: { kind: "global" }, proposal: { kind: "update", targets: [t.id] } }, DREAM).memory;
    svc.approve(p.id);
    assert.equal(store.get(t.id)?.domain, "git");
  });

  describe("proposals", () => {
    function kept(svc: UserMemoryService, text: string, scope: UserMemory["scope"] = { kind: "global" }) {
      return svc.create({ text, category: "work-style", scope, tier: "always" });
    }
    const propose = (svc: UserMemoryService, text: string, kind: "update" | "merge" | "promote" | "retire", targets: string[]) =>
      svc.suggest({ text, category: "work-style", scope: { kind: "global" }, proposal: { kind, targets, confidence: 3 } }, DREAM);

    it("update rewrites the target and spends the suggestion", () => {
      const { svc, store } = make();
      const t = kept(svc, "Verify with lint and tests.");
      const p = propose(svc, "Verify with lint and tests; never restart Eos.", "update", [t.id]).memory;
      const out = svc.approve(p.id);
      assert.equal(out?.id, t.id);
      assert.equal(store.get(t.id)?.text, "Verify with lint and tests; never restart Eos.");
      assert.ok(!store.has(p.id));
    });

    it("an update that changes nothing is a duplicate of its target", () => {
      const { svc } = make();
      const t = kept(svc, "Verify with lint and tests.");
      assert.equal(propose(svc, "verify with lint and tests", "update", [t.id]).memory.id, t.id);
    });

    it("merge keeps the merged text and removes the parts", () => {
      const { svc, store } = make();
      const a = kept(svc, "Chat in Turkish.");
      const b = kept(svc, "Commits in English.");
      const p = propose(svc, "Chat in Turkish; ship everything in English.", "merge", [a.id, b.id]).memory;
      assert.equal(svc.approve(p.id)?.status, "active");
      assert.ok(!store.has(a.id) && !store.has(b.id));
      assert.equal(store.get(p.id)?.proposal, undefined);
    });

    it("promote makes a project memory global; retire removes it", () => {
      const { svc, store } = make();
      const t = kept(svc, "Keep diffs surgical.", { kind: "project", path: "/eos" });
      svc.approve(propose(svc, "Keep diffs surgical.", "promote", [t.id]).memory.id);
      assert.deepEqual(store.get(t.id)?.scope, { kind: "global" });
      const old = kept(svc, "claude-cli is the fallback lane.");
      assert.equal(svc.approve(propose(svc, "Removed in 368cc14f.", "retire", [old.id]).memory.id), null);
      assert.ok(!store.has(old.id));
    });

    it("a proposal whose target is gone can't be filed or kept", () => {
      const { svc } = make();
      assert.throws(() => propose(svc, "x y z", "retire", ["um-gone0000"]), ConflictError);
      const t = kept(svc, "Something kept here.");
      const p = propose(svc, "Something kept here, updated text.", "update", [t.id]).memory;
      svc.remove(t.id);
      assert.throws(() => svc.approve(p.id), ConflictError);
      assert.deepEqual(svc.approveAll(), []); // skipped, not thrown
    });
  });

  it("search sees only kept memories in scope", () => {
    const { svc } = make();
    svc.create({ text: "Prefers pnpm.", category: "stack", scope: { kind: "global" }, tier: "on-demand" });
    svc.suggest({ text: "Pending pnpm thing.", category: "stack", scope: { kind: "global" } }, AGENT);
    assert.deepEqual(svc.search("pnpm", null, 5).map((m) => m.text), ["Prefers pnpm."]);
  });
});
