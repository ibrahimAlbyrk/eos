import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicModelClient, parseAnthropicResponse } from "../backends/AnthropicModelClient.ts";
import type { ModelMessage } from "../../../core/src/ports/ModelClient.ts";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

// Verifies request construction + response parsing with an injected fetch — no
// live (billed) call. The mapping is what the anthropic-api backend relies on.

function mockFetch(capture: { url?: string; init?: FetchInit }, response: unknown) {
  return (async (url: string, init: FetchInit) => {
    capture.url = url;
    capture.init = init;
    return { ok: true, async json() { return response; } } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("AnthropicModelClient", () => {
  it("builds the Messages API request (url, headers, mapped messages + tools)", async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const client = createAnthropicModelClient({
      apiKey: "sk-test", model: "claude-sonnet-4-6", system: "be brief",
      tools: [{ name: "echo", description: "echo", input_schema: { type: "object" } }],
      fetchImpl: mockFetch(cap, { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }),
    });
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ callId: "t1", name: "echo", input: { x: 1 } }] },
      { role: "tool", content: { callId: "t1", result: "ok", isError: false } },
    ];
    await client.createTurn(messages);
    assert.match(cap.url!, /\/v1\/messages$/);
    const headers = cap.init!.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test");
    assert.ok(headers["anthropic-version"]);
    const body = JSON.parse(cap.init!.body as string);
    assert.equal(body.model, "claude-sonnet-4-6");
    assert.equal(body.system, "be brief");
    assert.equal(body.tools.length, 1);
    // assistant tool-call message → tool_use block; tool message → tool_result block
    assert.equal(body.messages[1].content[0].type, "tool_use");
    assert.equal(body.messages[2].content[0].type, "tool_result");
    assert.equal(body.messages[2].content[0].tool_use_id, "t1");
  });

  it("parses a tool_use response into ModelTurn tool calls", () => {
    const turn = parseAnthropicResponse({
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 },
    });
    assert.equal(turn.text, "let me check");
    assert.equal(turn.stopReason, "tool_use");
    assert.deepEqual(turn.toolCalls, [{ callId: "tu_1", name: "Bash", input: { cmd: "ls" } }]);
    assert.equal(turn.usage?.inputTokens, 100);
    assert.equal(turn.usage?.cacheReadTokens, 10);
  });

  it("parses an end_turn text response with no tool calls", () => {
    const turn = parseAnthropicResponse({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    assert.equal(turn.stopReason, "end_turn");
    assert.equal(turn.toolCalls.length, 0);
    assert.equal(turn.text, "done");
  });

  it("surfaces a non-OK HTTP response as a model error (no throw)", async () => {
    const client = createAnthropicModelClient({
      apiKey: "sk", model: "m",
      fetchImpl: (async () => ({ ok: false, status: 401, async text() { return "unauthorized"; } })) as unknown as typeof fetch,
    });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.match(turn.error ?? "", /401/);
  });
});
