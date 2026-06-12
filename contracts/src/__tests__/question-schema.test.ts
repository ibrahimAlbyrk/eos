import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QuestionRequestSchema, QuestionAnswerRequestSchema } from "../http.ts";

const q = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  question: "Which approach?",
  options: [{ label: "A" }, { label: "B", description: "the safer one" }],
  ...over,
});

describe("QuestionRequestSchema", () => {
  // The ask_user MCP tool has no Claude tool_use_id — the daemon synthesizes
  // one. The schema must accept a missing/null id.
  it("accepts a body with no toolUseId", () => {
    assert.ok(QuestionRequestSchema.safeParse({ questions: [q()] }).success);
  });

  it("accepts a null toolUseId", () => {
    assert.ok(QuestionRequestSchema.safeParse({ questions: [q()], toolUseId: null }).success);
  });

  it("accepts header + multiSelect", () => {
    const r = QuestionRequestSchema.safeParse({
      questions: [q({ header: "Approach", multiSelect: true })],
    });
    assert.ok(r.success);
  });

  it("rejects a question without options", () => {
    assert.ok(!QuestionRequestSchema.safeParse({ questions: [{ question: "Q" }] }).success);
  });

  it("rejects an empty questions array", () => {
    assert.ok(!QuestionRequestSchema.safeParse({ questions: [] }).success);
  });

  it("rejects more than 4 questions", () => {
    assert.ok(!QuestionRequestSchema.safeParse({ questions: [q(), q(), q(), q(), q()] }).success);
  });
});

describe("QuestionAnswerRequestSchema", () => {
  it("accepts answers without a dismissed flag", () => {
    const r = QuestionAnswerRequestSchema.safeParse({ toolUseId: "tu1", answers: { Q: "A" } });
    assert.ok(r.success);
  });

  it("accepts a dismissal without answers", () => {
    const r = QuestionAnswerRequestSchema.safeParse({ toolUseId: "tu1", dismissed: true });
    assert.ok(r.success);
  });

  it("requires toolUseId", () => {
    assert.ok(!QuestionAnswerRequestSchema.safeParse({ answers: { Q: "A" } }).success);
  });
});
