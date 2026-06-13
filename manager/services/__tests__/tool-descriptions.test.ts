import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { renderToolDescriptions, withToolDescriptions } from "../../tool-descriptions.ts";

const promptsDir = join(import.meta.dirname, "..", "..", "prompts");

describe("renderToolDescriptions", () => {
  it("renders MCP tool descriptions from the prompt library with tool-name vars resolved", async () => {
    const d = await renderToolDescriptions(promptsDir, ["spawn_worker", "send_message_to_parent"]);
    assert.match(d.spawn_worker, /Spawn a new background Claude worker/);
    assert.match(d.spawn_worker, /get_worker/); // {{GET_WORKER_TOOL}} resolved from globals
    assert.doesNotMatch(d.spawn_worker, /\{\{/); // no unresolved variables
    assert.ok(d.send_message_to_parent.length > 100);
  });

  it("falls back to the bare tool name when a description is missing", async () => {
    const d = await renderToolDescriptions(promptsDir, ["does_not_exist"]);
    assert.equal(d.does_not_exist, "does_not_exist");
  });
});

describe("withToolDescriptions", () => {
  it("injects the rendered description into registerTool, ignoring the inline config", () => {
    let captured: string | undefined;
    const fake = { registerTool: (_n: string, cfg: { description?: string }) => { captured = cfg.description; } };
    const wrapped = withToolDescriptions(fake as never, { foo: "INJECTED" });
    (wrapped as never as { registerTool: (n: string, c: unknown, h: unknown) => void })
      .registerTool("foo", { description: "inline-ignored", inputSchema: {} }, () => {});
    assert.equal(captured, "INJECTED");
  });
});
