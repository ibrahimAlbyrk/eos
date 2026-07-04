import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromptPreviewRequestSchema } from "../http.ts";

describe("PromptPreviewRequestSchema", () => {
  it("defaults model to the 'high' tier (not a concrete alias)", () => {
    const parsed = PromptPreviewRequestSchema.parse({});
    assert.equal(parsed.model, "high");
  });

  it("accepts an explicit tier or concrete model", () => {
    assert.equal(PromptPreviewRequestSchema.parse({ model: "low" }).model, "low");
    assert.equal(PromptPreviewRequestSchema.parse({ model: "deepseek-v4-pro" }).model, "deepseek-v4-pro");
  });
});
