import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPeers, listPeersOf, isConsultable, resolvePeerRef } from "../services/Peers.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { PermissionDeniedError, NotFoundError } from "../errors/index.ts";

function row(p: Partial<WorkerRow> & { id: string }): WorkerRow {
  return {
    id: p.id, state: p.state ?? "IDLE", cwd: null, worktree_from: null, branch: null,
    prompt: p.prompt ?? "do the thing", name: p.name ?? null, pid: null, port: 1,
    started_at: 0, ended_at: null, exit_code: null,
    parent_id: p.parent_id ?? null, collaborate: p.collaborate ?? null,
    archived_at: p.archived_at ?? null,
  } as WorkerRow;
}

function repo(rows: WorkerRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    findById: (id: string) => byId.get(id) ?? null,
    listByParent: (parentId: string) => rows.filter((r) => r.parent_id === parentId),
  };
}

describe("Peers.assertPeers", () => {
  const r = repo([
    row({ id: "A", parent_id: "orch", collaborate: 1 }),
    row({ id: "B", parent_id: "orch", collaborate: 1 }),
    row({ id: "C", parent_id: "orch", collaborate: null }), // didn't opt in
    row({ id: "D", parent_id: "other", collaborate: 1 }),   // different parent
  ]);

  it("allows two collaborate siblings", () => {
    assert.doesNotThrow(() => assertPeers(r, "A", "B"));
  });
  it("rejects self-consultation", () => {
    assert.throws(() => assertPeers(r, "A", "A"), PermissionDeniedError);
  });
  it("rejects a non-collaborating target", () => {
    assert.throws(() => assertPeers(r, "A", "C"), PermissionDeniedError);
  });
  it("rejects a worker under a different parent", () => {
    assert.throws(() => assertPeers(r, "A", "D"), PermissionDeniedError);
  });
  it("rejects an unknown worker", () => {
    assert.throws(() => assertPeers(r, "A", "Z"), NotFoundError);
  });
});

describe("Peers.listPeersOf", () => {
  it("returns collaborate, alive siblings only — never self, non-collaborators, or dead", () => {
    const r = repo([
      row({ id: "A", parent_id: "orch", collaborate: 1 }),
      row({ id: "B", parent_id: "orch", collaborate: 1, state: "WORKING" }),
      row({ id: "C", parent_id: "orch", collaborate: null }),       // not collaborating
      row({ id: "X", parent_id: "orch", collaborate: 1, state: "DONE" }), // dead
      row({ id: "D", parent_id: "other", collaborate: 1 }),         // different parent
    ]);
    const ids = listPeersOf(r, "A").map((w) => w.id);
    assert.deepEqual(ids, ["B"]);
  });

  it("is empty for a non-collaborating or parentless worker", () => {
    const r = repo([
      row({ id: "A", parent_id: "orch", collaborate: null }),
      row({ id: "B", parent_id: "orch", collaborate: 1 }),
    ]);
    assert.deepEqual(listPeersOf(r, "A"), []);
  });

  it("includes a SUSPENDED sibling only when canLazyResume says its backend can revive", () => {
    const r = repo([
      row({ id: "A", parent_id: "orch", collaborate: 1 }),
      row({ id: "S", parent_id: "orch", collaborate: 1, state: "SUSPENDED" }),
    ]);
    assert.deepEqual(listPeersOf(r, "A").map((w) => w.id), []); // default: SUSPENDED hidden
    assert.deepEqual(listPeersOf(r, "A", () => true).map((w) => w.id), ["S"]);
  });

  it("never lists an archived sibling — even one lazy-resume could revive", () => {
    const r = repo([
      row({ id: "A", parent_id: "orch", collaborate: 1 }),
      row({ id: "Z", parent_id: "orch", collaborate: 1, state: "SUSPENDED", archived_at: 500 }),
      row({ id: "B", parent_id: "orch", collaborate: 1 }),
    ]);
    assert.deepEqual(listPeersOf(r, "A", () => true).map((w) => w.id), ["B"]);
  });
});

describe("Peers.isConsultable", () => {
  it("running states are consultable; ENDING/DONE/SUSPENDED are not", () => {
    for (const s of ["SPAWNING", "WORKING", "IDLE"]) assert.equal(isConsultable({ state: s as WorkerRow["state"] }), true);
    for (const s of ["ENDING", "DONE", "SUSPENDED"]) assert.equal(isConsultable({ state: s as WorkerRow["state"] }), false);
  });

  it("a SUSPENDED worker is consultable when its backend can be lazily revived", () => {
    assert.equal(isConsultable({ state: "SUSPENDED" }, true), true);
    assert.equal(isConsultable({ state: "SUSPENDED" }, false), false);
    // The flag only lifts SUSPENDED — a truly-gone DONE/ENDING peer stays out.
    assert.equal(isConsultable({ state: "DONE" }, true), false);
    assert.equal(isConsultable({ state: "ENDING" }, true), false);
  });
});

describe("Peers.resolvePeerRef", () => {
  const r = repo([
    row({ id: "A", name: "consumer", parent_id: "orch", collaborate: 1 }),
    row({ id: "B", name: "auth-expert", parent_id: "orch", collaborate: 1 }),
    row({ id: "X", name: "stale-expert", parent_id: "orch", collaborate: 1, state: "DONE" }),
    row({ id: "C", name: "loner", parent_id: "orch", collaborate: null }),
    row({ id: "D", name: "outsider", parent_id: "other", collaborate: 1 }),
  ]);

  it("resolves a live sibling by id", () => {
    const res = resolvePeerRef(r, "A", { id: "B" });
    assert.equal(res.kind, "resolved");
    assert.equal(res.kind === "resolved" && res.target.id, "B");
  });

  it("resolves a live sibling by name", () => {
    const res = resolvePeerRef(r, "A", { name: "auth-expert" });
    assert.equal(res.kind === "resolved" && res.target.id, "B");
  });

  it("is absent for an id that has no row yet (awaitable)", () => {
    assert.equal(resolvePeerRef(r, "A", { id: "ghost" }).kind, "absent");
  });

  it("is absent for a name no current sibling has (awaitable)", () => {
    assert.equal(resolvePeerRef(r, "A", { name: "billing-expert" }).kind, "absent");
  });

  it("is absent when the only name match is a dead sibling (a fresh one may arrive)", () => {
    assert.equal(resolvePeerRef(r, "A", { name: "stale-expert" }).kind, "absent");
  });

  it("denies a target id that is present but not consultable", () => {
    const res = resolvePeerRef(r, "A", { id: "X" });
    assert.equal(res.kind, "denied");
  });

  it("resolves a SUSPENDED sibling (by id and name) when its backend can be lazily revived", () => {
    const sr = repo([
      row({ id: "A", name: "consumer", parent_id: "orch", collaborate: 1 }),
      row({ id: "S", name: "sleeper", parent_id: "orch", collaborate: 1, state: "SUSPENDED" }),
    ]);
    // Without the capability the SUSPENDED peer is unreachable (denied by id,
    // awaitable by name — a fresh sibling could still arrive).
    assert.equal(resolvePeerRef(sr, "A", { id: "S" }).kind, "denied");
    assert.equal(resolvePeerRef(sr, "A", { name: "sleeper" }).kind, "absent");
    // With it, the peer resolves so the route can revive then deliver.
    const byId = resolvePeerRef(sr, "A", { id: "S" }, () => true);
    assert.equal(byId.kind === "resolved" && byId.target.id, "S");
    const byName = resolvePeerRef(sr, "A", { name: "sleeper" }, () => true);
    assert.equal(byName.kind === "resolved" && byName.target.id, "S");
  });

  it("treats an archived sibling as absent — by id and by name, lazy-resume or not", () => {
    const ar = repo([
      row({ id: "A", name: "consumer", parent_id: "orch", collaborate: 1 }),
      row({ id: "Z", name: "archived-expert", parent_id: "orch", collaborate: 1, state: "SUSPENDED", archived_at: 500 }),
    ]);
    // absent, never resolved: an archived worker must be invisible to agents,
    // and never denied-with-a-name either (that would leak its existence).
    assert.equal(resolvePeerRef(ar, "A", { id: "Z" }, () => true).kind, "absent");
    assert.equal(resolvePeerRef(ar, "A", { name: "archived-expert" }, () => true).kind, "absent");
  });

  it("denies self-consult by id", () => {
    assert.equal(resolvePeerRef(r, "A", { id: "A" }).kind, "denied");
  });

  it("denies self-consult by name (own name, no other match)", () => {
    assert.equal(resolvePeerRef(r, "A", { name: "consumer" }).kind, "denied");
  });

  it("denies an ambiguous name (more than one live match)", () => {
    const amb = repo([
      row({ id: "A", name: "consumer", parent_id: "orch", collaborate: 1 }),
      row({ id: "B1", name: "dup", parent_id: "orch", collaborate: 1 }),
      row({ id: "B2", name: "dup", parent_id: "orch", collaborate: 1 }),
    ]);
    assert.equal(resolvePeerRef(amb, "A", { name: "dup" }).kind, "denied");
  });

  it("denies when the asker is not in a collaboration group", () => {
    assert.equal(resolvePeerRef(r, "C", { id: "B" }).kind, "denied"); // C did not opt in
  });
});
