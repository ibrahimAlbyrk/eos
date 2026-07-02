import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkModelForProvider, modelMatchesFamily } from "../domain/model-provider.ts";
import type { BackendDescriptor, ModelCatalogRef } from "../ports/AgentBackend.ts";

function desc(models: ModelCatalogRef | undefined, over: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    kind: "test", label: "Test", processModel: "in-process", billing: "subscription",
    modelSource: "request", capabilities: {} as BackendDescriptor["capabilities"],
    models: models as ModelCatalogRef, auth: "subscription", enabled: true,
    sessionStore: "claude-transcript", ...over,
  };
}

describe("checkModelForProvider", () => {
  it("passes a valid model for the provider (claude catalog + Claude alias)", () => {
    assert.deepEqual(checkModelForProvider(desc({ kind: "claude" }), "opus"), { ok: true });
    assert.deepEqual(checkModelForProvider(desc({ kind: "claude" }), "claude-opus-4-8"), { ok: true });
  });

  it("rejects a wrong-provider model (a non-Claude id on a claude catalog)", () => {
    const r = checkModelForProvider(desc({ kind: "claude" }), "deepseek-chat");
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /deepseek-chat/);
  });

  it("passes on an openai-compatible catalog (valid set not statically known)", () => {
    assert.deepEqual(checkModelForProvider(desc({ kind: "openai-compatible" }), "deepseek-chat"), { ok: true });
    assert.deepEqual(checkModelForProvider(desc({ kind: "openai-compatible" }), "gpt-4o"), { ok: true });
  });

  it("rejects a Claude alias leaking onto an openai-compatible lane", () => {
    assert.equal(checkModelForProvider(desc({ kind: "openai-compatible" }), "opus").ok, false);
  });

  it("enforces a static catalog's explicit list", () => {
    const d = desc({ kind: "static", models: ["deepseek-chat", "gpt-4o"] });
    assert.deepEqual(checkModelForProvider(d, "deepseek-chat"), { ok: true });
    assert.equal(checkModelForProvider(d, "opus").ok, false);
  });

  it("fails open when the descriptor carries no catalog", () => {
    assert.deepEqual(checkModelForProvider(desc(undefined), "anything"), { ok: true });
  });
});

describe("modelMatchesFamily", () => {
  it("matches Claude aliases to the claude family only", () => {
    assert.equal(modelMatchesFamily("sonnet", "claude"), true);
    assert.equal(modelMatchesFamily("deepseek-chat", "claude"), false);
    assert.equal(modelMatchesFamily("opus", "openai-compatible"), false);
    assert.equal(modelMatchesFamily("gpt-4o", "openai-compatible"), true);
  });

  it("fails open for an unknown family", () => {
    assert.equal(modelMatchesFamily("opus", undefined), true);
  });
});
