import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QuestionRequestSchema, QuestionNotifyRequestSchema } from "../http.ts";

// Regression: the PermissionRequest hook payload has no tool_use_id, so the
// worker hook posts toolUseId null/absent. A strict z.string() rejected that
// with 400, so no question_pending event was appended and the banner never
// appeared. Both question endpoints must accept a missing/null id (the daemon
// synthesizes one).
for (const [name, schema] of [
  ["QuestionRequestSchema", QuestionRequestSchema],
  ["QuestionNotifyRequestSchema", QuestionNotifyRequestSchema],
] as const) {
  describe(`${name} toolUseId tolerance`, () => {
    it("accepts a body with no toolUseId", () => {
      const r = schema.safeParse({ questions: [{ question: "Q" }] });
      assert.ok(r.success, "missing toolUseId should pass");
    });

    it("accepts a null toolUseId (what jq emits for an absent field)", () => {
      const r = schema.safeParse({ questions: [{ question: "Q" }], toolUseId: null });
      assert.ok(r.success, "null toolUseId should pass");
    });

    it("still accepts a real string toolUseId", () => {
      const r = schema.safeParse({ questions: [{ question: "Q" }], toolUseId: "toolu_123" });
      assert.ok(r.success);
    });

    it("still requires questions to be an array", () => {
      const r = schema.safeParse({ toolUseId: "toolu_123" });
      assert.ok(!r.success, "missing questions must fail");
    });
  });
}
