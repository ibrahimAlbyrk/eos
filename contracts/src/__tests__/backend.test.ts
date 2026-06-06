import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackendProfileSchema, AuthRefSchema, BackendDefaultsSchema } from "../backend.ts";

describe("BackendProfileSchema", () => {
  it("accepts a minimal claude-cli profile", () => {
    const p = BackendProfileSchema.parse({ kind: "claude-cli", model: "opus" });
    assert.equal(p.kind, "claude-cli");
    assert.equal(p.model, "opus");
  });

  it("accepts an API profile with an env auth ref + costMode", () => {
    const p = BackendProfileSchema.parse({
      kind: "anthropic-api",
      model: "claude-sonnet-4-6",
      auth: { kind: "env", ref: "ANTHROPIC_API_KEY" },
      costMode: "billed",
    });
    assert.equal(p.auth?.ref, "ANTHROPIC_API_KEY");
    assert.equal(p.costMode, "billed");
  });

  it("rejects an unknown backend kind", () => {
    assert.throws(() => BackendProfileSchema.parse({ kind: "bogus", model: "x" }));
  });

  it("rejects unknown top-level keys (strict)", () => {
    assert.throws(() => BackendProfileSchema.parse({ kind: "codex", model: "x", secret: "nope" }));
  });
});

describe("AuthRefSchema", () => {
  it("accepts subscription with no ref", () => {
    assert.deepEqual(AuthRefSchema.parse({ kind: "subscription" }), { kind: "subscription" });
  });
  it("rejects an unknown auth kind", () => {
    assert.throws(() => AuthRefSchema.parse({ kind: "plaintext", ref: "sk-..." }));
  });
});

describe("BackendDefaultsSchema", () => {
  it("accepts a partial (worker-only) default", () => {
    const d = BackendDefaultsSchema.parse({ worker: { backend: "sonnet-api" } });
    assert.equal(d.worker?.backend, "sonnet-api");
    assert.equal(d.orchestrator, undefined);
  });
});
