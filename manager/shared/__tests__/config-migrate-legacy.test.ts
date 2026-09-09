import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateLegacyBackends } from "../config.ts";

test("migrateLegacyBackends rewrites legacy kinds + profile names + defaults", () => {
  const raw: Record<string, unknown> = {
    backends: {
      "claude-sdk-opus": { kind: "claude-sdk", model: "claude-opus-5" },
      "claude-cli-opus": { kind: "claude-cli", model: "opus" },
      "my-custom": { kind: "claude-cli", model: "sonnet" },
    },
    defaults: { orchestrator: { backend: "claude-sdk-opus" }, worker: { backend: "claude-cli-opus" } },
  };
  migrateLegacyBackends(raw);
  const b = raw.backends as Record<string, { kind: string }>;
  assert.equal(b["claude-sdk-opus"], undefined);
  assert.equal(b["claude-cli-opus"], undefined);
  assert.equal(b["claude-opus"]?.kind, "claude");   // claude-sdk-opus won the claude-opus slot
  assert.equal(b["my-custom"]?.kind, "claude");      // legacy kind rewritten, custom key kept
  const d = raw.defaults as Record<string, { backend: string }>;
  assert.equal(d.orchestrator.backend, "claude-opus");
  assert.equal(d.worker.backend, "claude-opus");
});
