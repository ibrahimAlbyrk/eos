import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPeers, listPeersOf, isConsultable } from "../services/Peers.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { PermissionDeniedError, NotFoundError } from "../errors/index.ts";

function row(p: Partial<WorkerRow> & { id: string }): WorkerRow {
  return {
    id: p.id, state: p.state ?? "IDLE", cwd: null, worktree_from: null, branch: null,
    prompt: p.prompt ?? "do the thing", name: p.name ?? null, pid: null, port: 1,
    started_at: 0, ended_at: null, exit_code: null,
    parent_id: p.parent_id ?? null, collaborate: p.collaborate ?? null,
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
});

describe("Peers.isConsultable", () => {
  it("running states are consultable; ENDING/DONE/SUSPENDED are not", () => {
    for (const s of ["SPAWNING", "WORKING", "IDLE"]) assert.equal(isConsultable({ state: s as WorkerRow["state"] }), true);
    for (const s of ["ENDING", "DONE", "SUSPENDED"]) assert.equal(isConsultable({ state: s as WorkerRow["state"] }), false);
  });
});
