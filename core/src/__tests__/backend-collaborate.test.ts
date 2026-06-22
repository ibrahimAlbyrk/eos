import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backendCollaborate } from "../ports/AgentBackend.ts";
import type { SpawnWorkerSpec } from "../use-cases/SpawnWorker.ts";

// Regression guard for the peer-mesh threading. SpawnWorker / ResumeWorker build
// backendOptions as { spec: withBranch }, so the collaborate opt-in lives ONLY
// inside spec. A structured lane (claude-sdk / in-process) that read a top-level
// backendOptions.collaborate saw undefined and silently dropped all peer tools on
// a collaborate=true worker. backendCollaborate is the one resolver every lane
// shares.
describe("backendCollaborate — peer-mesh opt-in resolves from the canonical spec", () => {
  it("collaborate=true on the spec resolves true (the exact shape SpawnWorker builds)", () => {
    const opts = { spec: { collaborate: true } as SpawnWorkerSpec };
    assert.equal(backendCollaborate(opts), true);
  });

  it("collaborate=false or absent on the spec resolves false", () => {
    assert.equal(backendCollaborate({ spec: { collaborate: false } as SpawnWorkerSpec }), false);
    assert.equal(backendCollaborate({ spec: {} as SpawnWorkerSpec }), false);
  });

  it("no spec / no options resolves false (spec-less launches like the judge never collaborate)", () => {
    assert.equal(backendCollaborate({}), false);
    assert.equal(backendCollaborate(undefined), false);
  });

  it("a top-level collaborate field is NOT consulted (guards against the dropped-flag regression)", () => {
    // If a future edit reintroduces a top-level read, this stays false because the
    // value belongs on spec — catching the exact bug this resolver fixed.
    const opts = { collaborate: true } as unknown as Parameters<typeof backendCollaborate>[0];
    assert.equal(backendCollaborate(opts), false);
  });
});
