import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deleteWorkflowDefinition } from "../use-cases/DeleteWorkflowDefinition.ts";
import { NotFoundError, ValidationError } from "../errors/index.ts";
import type { RuntimeWorkflowDefinitionStore } from "../ports/RuntimeWorkflowDefinitionStore.ts";

// Minimal in-memory store recording delete calls; only delete() matters here.
function fakeStore(rows: Array<{ owner: string; name: string }>): RuntimeWorkflowDefinitionStore {
  return {
    create() {},
    listFor() { return []; },
    delete(owner: string, name: string): boolean {
      const i = rows.findIndex((r) => r.owner === owner && r.name === name);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    deleteForOwner() {},
  };
}

describe("deleteWorkflowDefinition", () => {
  it("deletes a stored runtime definition and returns its name", () => {
    const rows = [{ owner: "operator", name: "t4-inner-sum" }];
    const out = deleteWorkflowDefinition(
      { store: fakeStore(rows), isBuiltin: () => false },
      { ownerId: "operator", name: "t4-inner-sum" },
    );
    assert.deepEqual(out, { name: "t4-inner-sum" });
  });

  it("rejects deleting a builtin (code, not removable)", () => {
    assert.throws(
      () => deleteWorkflowDefinition(
        { store: fakeStore([]), isBuiltin: (n) => n === "build-with-experts" },
        { ownerId: "operator", name: "build-with-experts" },
      ),
      (e) => e instanceof ValidationError && /cannot delete builtin/.test(e.message),
    );
  });

  it("404s an unknown name (not stored, not builtin)", () => {
    assert.throws(
      () => deleteWorkflowDefinition(
        { store: fakeStore([]), isBuiltin: () => false },
        { ownerId: "operator", name: "ghost" },
      ),
      (e) => e instanceof NotFoundError && /workflow definition not found: ghost/.test(e.message),
    );
  });

  it("a runtime def shadowing a builtin name is still deletable (drops the overlay)", () => {
    const rows = [{ owner: "operator", name: "build-with-experts" }];
    const out = deleteWorkflowDefinition(
      { store: fakeStore(rows), isBuiltin: (n) => n === "build-with-experts" },
      { ownerId: "operator", name: "build-with-experts" },
    );
    assert.deepEqual(out, { name: "build-with-experts" }, "the stored row is removed before the builtin guard");
  });
});
