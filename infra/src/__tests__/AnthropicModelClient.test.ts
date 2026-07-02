import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicModelClient, parseAnthropicResponse } from "../backends/AnthropicModelClient.ts";
import type { ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const ANTH = (over: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  wire: "anthropic", supportsStreaming: false, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "none", reasoningRoundTrip: "preserve-signed", cache: "none", structuredOutput: "none", contextWindow: 200000, ...over,
});
function captureBody(cap: { body?: Record<string, unknown> }): typeof fetch {
  return (async (_url: string, init: FetchInit) => {
    cap.body = JSON.parse(init.body as string);
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }; } } as unknown as Response;
  }) as unknown as typeof fetch;
}

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

  it("surfaces an unclassified non-OK HTTP response as a raw model error (no throw)", async () => {
    const client = createAnthropicModelClient({
      apiKey: "sk", model: "m",
      fetchImpl: (async () => ({ ok: false, status: 403, headers: { get: () => null }, async text() { return "forbidden"; } })) as unknown as typeof fetch,
    });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.match(turn.error ?? "", /403/);
  });

  it("maps a 400 credit-balance body to the typed insufficient_credits error", async () => {
    const client = createAnthropicModelClient({
      apiKey: "sk", model: "m",
      fetchImpl: (async () => ({ ok: false, status: 400, headers: { get: () => null }, async text() { return JSON.stringify({ error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }); } })) as unknown as typeof fetch,
    });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.equal(turn.error, "insufficient_credits");
  });

  it("maps a 401 to the typed auth_invalid error", async () => {
    const client = createAnthropicModelClient({
      apiKey: "sk", model: "m",
      fetchImpl: (async () => ({ ok: false, status: 401, headers: { get: () => null }, async text() { return JSON.stringify({ error: { message: "invalid x-api-key" } }); } })) as unknown as typeof fetch,
    });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.equal(turn.error, "auth_invalid");
  });

  it("maps a context-overflow 400 to the typed context_window_exceeded error (recoverable trigger)", async () => {
    const client = createAnthropicModelClient({
      apiKey: "sk", model: "m",
      fetchImpl: (async () => ({ ok: false, status: 400, headers: { get: () => null }, async text() { return JSON.stringify({ error: { message: "prompt is too long: 250000 tokens > 200000 maximum context length" } }); } })) as unknown as typeof fetch,
    });
    const turn = await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(turn.stopReason, "error");
    assert.equal(turn.error, "context_window_exceeded");
  });

  it("parseAnthropicResponse captures signed thinking blocks into providerMetadata", () => {
    const turn = parseAnthropicResponse({
      content: [
        { type: "thinking", thinking: "weigh options", signature: "SIG-7" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
    });
    assert.equal(turn.reasoning, "weigh options");
    assert.deepEqual(turn.providerMetadata?.anthropicThinking, [{ type: "thinking", thinking: "weigh options", signature: "SIG-7" }]);
  });
});

describe("AnthropicModelClient — M4 capability-driven request shaping", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

  it("injects cache_control on the system block + last tool when cache:anthropic-explicit", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createAnthropicModelClient({
      apiKey: "k", model: "m", system: "be brief", capabilities: ANTH({ cache: "anthropic-explicit" }),
      tools: [{ name: "a", description: "a", input_schema: { type: "object" } }, { name: "b", description: "b", input_schema: { type: "object" } }],
      fetchImpl: captureBody(cap),
    });
    await client.createTurn(messages);
    const system = cap.body!.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    assert.equal(system[0].cache_control && (system[0].cache_control as { type: string }).type, "ephemeral");
    const tools = cap.body!.tools as Array<{ cache_control?: { type: string } }>;
    assert.equal(tools[0].cache_control, undefined, "breakpoint only on the LAST tool");
    assert.equal(tools[1].cache_control?.type, "ephemeral");
  });

  it("leaves the system block a plain string when cache is not anthropic-explicit", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", system: "be brief", capabilities: ANTH({ cache: "automatic" }), fetchImpl: captureBody(cap) });
    await client.createTurn(messages);
    assert.equal(cap.body!.system, "be brief");
  });

  it("uses capability/param max_tokens (the 4096 default is too low for reasoning)", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: ANTH({ maxTokens: 32000 }), fetchImpl: captureBody(cap) });
    await client.createTurn(messages);
    assert.equal(cap.body!.max_tokens, 32000);

    const cap2: { body?: Record<string, unknown> } = {};
    const client2 = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: ANTH({ maxTokens: 32000 }), params: { max_tokens: 8000 }, fetchImpl: captureBody(cap2) });
    await client2.createTurn(messages);
    assert.equal(cap2.body!.max_tokens, 8000, "params.max_tokens overrides capability");
  });

  it("maps effort→thinking budget when reasoning:anthropic-thinking, omitting temperature", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: ANTH({ reasoning: "anthropic-thinking", maxTokens: 4096 }), effort: "high", params: { temperature: 0.5 }, fetchImpl: captureBody(cap) });
    await client.createTurn(messages);
    const thinking = cap.body!.thinking as { type: string; budget_tokens: number };
    assert.equal(thinking.type, "enabled");
    assert.ok(thinking.budget_tokens >= 1024);
    assert.ok((cap.body!.max_tokens as number) > thinking.budget_tokens, "max_tokens raised above the thinking budget");
    assert.equal("temperature" in cap.body!, false, "temperature omitted when thinking is on");
  });

  it("applies params.temperature when thinking is off", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: ANTH({ reasoning: "none" }), params: { temperature: 0.3 }, fetchImpl: captureBody(cap) });
    await client.createTurn(messages);
    assert.equal(cap.body!.temperature, 0.3);
  });
});
