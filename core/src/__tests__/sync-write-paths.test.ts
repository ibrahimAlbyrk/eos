import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UserMemoryService } from "../services/UserMemoryService.ts";
import { PageService } from "../services/PageService.ts";
import { UserProfileService } from "../services/UserProfileService.ts";
import type { UserMemory, UserProfile } from "../../../contracts/src/profile.ts";
import type { Page } from "../../../contracts/src/http.ts";

const clock = { now: () => 5000 };

function recorder() {
  const events: { topic: string; payload: unknown }[] = [];
  return { events, bus: { publish: (topic: string, payload: unknown) => { events.push({ topic, payload }); } } };
}

describe("sync write paths", () => {
  it("a synced memory is stored as given, rev continuing locally, announced as sync", () => {
    const rows = new Map<string, UserMemory>();
    const { events, bus } = recorder();
    const svc = new UserMemoryService({
      store: { list: () => [...rows.values()], get: (id) => rows.get(id) ?? null, put: (m) => { rows.set(m.id, m); }, remove: (id) => rows.delete(id) },
      clock, bus, newId: () => "um-unused0000",
    });
    const incoming = {
      id: "um-abcdef123456", text: "Prefers pnpm", category: "stack", scope: { kind: "global" }, tier: "always",
      status: "suggested", source: { kind: "dream", dreamId: "dr-1", evidence: [] }, createdAt: 10, updatedAt: 20,
    } as const;
    assert.equal(svc.applySynced(incoming).rev, 0);
    assert.equal(svc.applySynced({ ...incoming, text: "Prefers pnpm only" }).rev, 1);
    assert.equal(rows.get(incoming.id)?.updatedAt, 20);
    svc.removeSynced(incoming.id);
    svc.removeSynced(incoming.id);
    assert.deepEqual(events.map((e) => (e.payload as { action: string; by: string })), [
      { id: incoming.id, action: "created", status: "suggested", by: "sync" },
      { id: incoming.id, action: "updated", status: "suggested", by: "sync" },
      { id: incoming.id, action: "deleted", status: "suggested", by: "sync" },
    ]);
  });

  it("a synced page keeps this Mac's chat link", () => {
    const rows = new Map<string, Page>();
    const { bus } = recorder();
    const svc = new PageService({
      store: { list: () => [...rows.values()], get: (id) => rows.get(id) ?? null, put: (p) => { rows.set(p.id, p); }, remove: (id) => rows.delete(id) },
      clock, bus, newId: () => "pg-unused0000",
    });
    const by = { kind: "user" as const, agentId: null, name: null };
    rows.set("pg-abcdef123456", { id: "pg-abcdef123456", title: "t", body: "a", project: null, agentId: "w-1", rev: 3, createdAt: 1, updatedAt: 1, updatedBy: by });
    const saved = svc.applySynced({ id: "pg-abcdef123456", title: "t", body: "b", project: null, createdAt: 1, updatedAt: 9, updatedBy: by });
    assert.equal(saved.agentId, "w-1");
    assert.equal(saved.rev, 4);
    assert.equal(saved.updatedAt, 9);
  });

  it("synced profile fields never touch this Mac's avatar or dreaming", () => {
    let stored: UserProfile | null = null;
    const svc = new UserProfileService({
      store: { get: () => stored, put: (p) => { stored = p; } },
      avatars: { read: () => null, write: () => {}, remove: () => {} },
      clock, bus: recorder().bus,
    });
    svc.update({ dreaming: { enabled: true } });
    stored = { ...stored!, identity: { ...stored!.identity, avatar: "png" } };
    const before = svc.get().rev;
    const p = svc.applySynced({ identity: { fullName: "Ibrahim", callName: "ibrahim", handle: "" }, budgetTokens: 1200 });
    assert.equal(p.identity.fullName, "Ibrahim");
    assert.equal(p.identity.avatar, "png");
    assert.equal(p.dreaming.enabled, true);
    assert.equal(p.rev, before + 1);
    assert.equal(svc.applySynced({ budgetTokens: 1200 }).rev, before + 1, "no change, no new rev");
  });
});
