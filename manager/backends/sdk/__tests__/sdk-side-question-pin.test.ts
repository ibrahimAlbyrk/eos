import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The /btw side question calls Query.askSideQuestion, which the installed SDK
// ships but leaves out of its typings. This fails an SDK bump that drops or
// renames it, instead of /btw breaking at runtime.
describe("claude-agent-sdk side question", () => {
  it("the installed Query still sends the side_question control request", () => {
    const sdk = readFileSync(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")), "utf8");
    assert.match(sdk, /async askSideQuestion\(\w+,\w+\)/);
    assert.match(sdk, /subtype:"side_question",question:/);
  });
});
