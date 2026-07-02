import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnWorkerHandler } from "../handlers/spawn-worker.ts";
import { ConflictError, ValidationError } from "../../../core/src/errors/index.ts";
import type { Container } from "../../container.ts";

// ADR-3: archived workers are invisible to agents, so spawn_worker({workspaceOf})
// must not boot a fresh agent into an archived worker's worktree — that would
// revive a hidden workspace. The guard sits before any definition resolution or
// side effect; a container stubbed past nothing but findById proves the ordering.

function containerWith(row: { id: string; archived_at: number | null } | null) {
  let lookups = 0;
  const c = {
    workers: { findById: (_id: string) => { lookups++; return row; } },
    listWorkerDefinitionRecords: () => [],
  } as unknown as Container;
  return { c, get lookups() { return lookups; } };
}

const body = (workspaceOf: string) => ({ prompt: "go", cwd: "/repo", workspaceOf }) as never;

describe("spawn-worker — workspaceOf archived guard", () => {
  it("rejects an archived workspaceOf target with ConflictError before any resolution", async () => {
    const h = containerWith({ id: "w-arch", archived_at: 5000 });
    await assert.rejects(
      () => spawnWorkerHandler.run({}, body("w-arch"), { c: h.c, requestId: "t" } as never),
      (e: unknown) => e instanceof ConflictError && /archived/.test((e as Error).message),
    );
    assert.equal(h.lookups, 1);
  });

  it("a live workspaceOf target passes the guard (fails later, in definition resolution)", async () => {
    const h = containerWith({ id: "w-live", archived_at: null });
    // Empty definition records ⇒ the handler fails PAST the guard with the
    // definition-resolution ValidationError, never the archived ConflictError.
    await assert.rejects(
      () => spawnWorkerHandler.run({}, body("w-live"), { c: h.c, requestId: "t" } as never),
      (e: unknown) => e instanceof ValidationError,
    );
  });
});
