import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertOwnedBy } from "../services/WorkerOwnership.ts";
import { NotFoundError, PermissionDeniedError } from "../errors/index.ts";

function repoWith(rows: Record<string, { parent_id?: string | null }>) {
  return { findById: (id: string) => rows[id] ?? null };
}

describe("assertOwnedBy", () => {
  it("passes for a direct child", () => {
    const repo = repoWith({ "w-1": { parent_id: "orch-1" } });
    assert.doesNotThrow(() => assertOwnedBy(repo, "orch-1", "w-1"));
  });

  it("denies a worker owned by another orchestrator", () => {
    const repo = repoWith({ "w-1": { parent_id: "orch-2" } });
    assert.throws(() => assertOwnedBy(repo, "orch-1", "w-1"), PermissionDeniedError);
  });

  it("denies a parentless (user-spawned) worker", () => {
    const repo = repoWith({ "w-1": { parent_id: null } });
    assert.throws(() => assertOwnedBy(repo, "orch-1", "w-1"), PermissionDeniedError);
  });

  it("denies a grandchild — ownership is the direct parent link only", () => {
    const repo = repoWith({ "w-mid": { parent_id: "orch-1" }, "w-deep": { parent_id: "w-mid" } });
    assert.throws(() => assertOwnedBy(repo, "orch-1", "w-deep"), PermissionDeniedError);
  });

  it("throws NotFound for a missing worker", () => {
    const repo = repoWith({});
    assert.throws(() => assertOwnedBy(repo, "orch-1", "w-gone"), NotFoundError);
  });

  it("self is denied unless allowSelf is set", () => {
    const repo = repoWith({ "orch-1": { parent_id: null } });
    assert.throws(() => assertOwnedBy(repo, "orch-1", "orch-1"), PermissionDeniedError);
    assert.doesNotThrow(() => assertOwnedBy(repo, "orch-1", "orch-1", { allowSelf: true }));
  });
});
