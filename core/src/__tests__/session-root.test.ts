import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sessionRootOf } from "../services/session-root.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

// Minimal repo double: sessionRootOf only reads findById → { parent_id }.
function repo(rows: Record<string, string | null>): Pick<WorkerRepo, "findById"> {
  return {
    findById: (id: string) => (id in rows ? ({ id, parent_id: rows[id] } as WorkerRow) : null),
  };
}

describe("sessionRootOf", () => {
  it("walks a child chain to the parent-chain root", () => {
    const workers = repo({ "o-root": null, "w-mid": "o-root", "w-leaf": "w-mid" });
    assert.equal(sessionRootOf(workers, "w-leaf"), "o-root");
    assert.equal(sessionRootOf(workers, "w-mid"), "o-root");
  });

  it("a root id resolves to itself", () => {
    const workers = repo({ "o-root": null });
    assert.equal(sessionRootOf(workers, "o-root"), "o-root");
  });

  it("an unknown id returns itself", () => {
    const workers = repo({ "o-root": null });
    assert.equal(sessionRootOf(workers, "w-ghost"), "w-ghost");
  });

  it("a dangling parent_id stops at the last resolvable ancestor", () => {
    const workers = repo({ "w-leaf": "w-gone" });
    assert.equal(sessionRootOf(workers, "w-leaf"), "w-leaf");
  });

  it("a parent cycle is guarded and terminates", () => {
    const workers = repo({ a: "b", b: "a" });
    assert.equal(sessionRootOf(workers, "a"), "b");
  });
});
