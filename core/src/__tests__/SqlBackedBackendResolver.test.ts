import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SqlBackedBackendResolver } from "../services/SqlBackedBackendResolver.ts";
import type { BackendDefaults, ResolvedBackend } from "../ports/BackendDefaults.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const PROFILES: Record<string, ResolvedBackend> = {
  "claude-cli-opus": { kind: "claude-cli", model: "opus", profileName: "claude-cli-opus", costMode: "included" },
  "sonnet-api": { kind: "anthropic-api", model: "claude-sonnet-4-6", profileName: "sonnet-api", costMode: "billed" },
};

function defaults(roleDefault: string | null = "claude-cli-opus"): BackendDefaults {
  return {
    profile: (name) => PROFILES[name] ?? null,
    roleDefaultName: () => roleDefault,
  };
}

function repo(rows: Record<string, Partial<WorkerRow>>): WorkerRepo {
  return { findById: (id: string) => (rows[id] ?? null) as WorkerRow | null } as unknown as WorkerRepo;
}

describe("SqlBackedBackendResolver", () => {
  it("1. explicit profile on the request wins", () => {
    const r = new SqlBackedBackendResolver(repo({}), defaults());
    const out = r.resolveForNewWorker({ explicitProfileName: "sonnet-api", isOrchestrator: false });
    assert.equal(out.kind, "anthropic-api");
    assert.equal(out.profileName, "sonnet-api");
  });

  it("2. inherits the parent's explicit backend_kind", () => {
    const r = new SqlBackedBackendResolver(
      repo({ orch: { backend_kind: "anthropic-api", model: "claude-sonnet-4-6", parent_id: null } }),
      defaults(),
    );
    const out = r.resolveForNewWorker({ parentId: "orch", isOrchestrator: false });
    assert.equal(out.kind, "anthropic-api");
    assert.equal(out.model, "claude-sonnet-4-6");
  });

  it("2. inherits a named profile from an ancestor (climbs multiple levels)", () => {
    const r = new SqlBackedBackendResolver(
      repo({
        grand: { backend_profile: "sonnet-api", parent_id: null },
        mid: { backend_kind: null as unknown as string, parent_id: "grand" },
      }),
      defaults(),
    );
    const out = r.resolveForNewWorker({ parentId: "mid", isOrchestrator: false });
    assert.equal(out.kind, "anthropic-api");
    assert.equal(out.profileName, "sonnet-api");
  });

  it("3. falls back to the role default when no parent/explicit", () => {
    const r = new SqlBackedBackendResolver(repo({}), defaults("claude-cli-opus"));
    const out = r.resolveForNewWorker({ isOrchestrator: true });
    assert.equal(out.profileName, "claude-cli-opus");
    assert.equal(out.kind, "claude-cli");
  });

  it("4. falls back to the global claude-cli default when nothing is configured", () => {
    const r = new SqlBackedBackendResolver(repo({}), defaults(null));
    const out = r.resolveForNewWorker({ isOrchestrator: false });
    assert.deepEqual(out, { kind: "claude-cli", model: "opus", profileName: null });
  });

  it("is cycle-safe on a malformed parent chain", () => {
    const r = new SqlBackedBackendResolver(
      repo({ a: { parent_id: "b", backend_kind: null as unknown as string }, b: { parent_id: "a", backend_kind: null as unknown as string } }),
      defaults(null),
    );
    const out = r.resolveForNewWorker({ parentId: "a", isOrchestrator: false });
    assert.equal(out.kind, "claude-cli"); // didn't hang; fell through to global default
  });
});
