import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIModelClient, parseOpenAIResponse, parseOpenAIStream } from "../backends/OpenAIModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

// OpenAI-compatible robustness (06 §2.3) + capability-driven request shaping:
// tolerate streamed tool-deltas with no index/id; read DeepSeek's cache field; emit
// reasoning_effort / temperature / max_tokens / structured-output ONLY when the
// capability supports them (droppable — the LiteLLM drop_params lesson); gate
// streamTurn on supportsStreaming.

type FetchInit = { body?: string };
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}
const CAPS = (over: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  wire: "openai-chat", supportsStreaming: true, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "none", reasoningRoundTrip: "drop", cache: "automatic", structuredOutput: "none", contextWindow: 8192, ...over,
});
function captureFetch(cap: { body?: Record<string, unknown> }): typeof fetch {
  return (async (_url: string, init: FetchInit) => {
    cap.body = JSON.parse(init.body as string);
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }; } } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("parseOpenAIStream — tolerant tool-delta accumulation (missing index/id)", () => {
  it("a new id opens a new slot when index is omitted", async () => {
    const turn = await parseOpenAIStream(sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"Read","arguments":"{}"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"Bash","arguments":"{}"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ]), {});
    assert.equal(turn.toolCalls.length, 2);
    assert.deepEqual(turn.toolCalls.map((t) => t.name).sort(), ["Bash", "Read"]);
  });

  it("a bare continuation fragment (no index/id) appends to the most recent slot", async () => {
    const turn = await parseOpenAIStream(sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"Read","arguments":"{\\"file"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"_path\\":\\"/x\\"}"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ]), {});
    assert.deepEqual(turn.toolCalls, [{ callId: "a", name: "Read", input: { file_path: "/x" } }]);
  });
});

describe("token/cache accounting", () => {
  it("reads DeepSeek prompt_cache_hit_tokens into cacheReadTokens", () => {
    const turn = parseOpenAIResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 } });
    assert.equal(turn.usage?.cacheReadTokens, 40);
  });
  it("prefers OpenAI prompt_tokens_details.cached_tokens when both are present", () => {
    const turn = parseOpenAIResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 }, prompt_cache_hit_tokens: 40 } });
    assert.equal(turn.usage?.cacheReadTokens, 60);
  });
});

describe("capability-driven request shaping (droppable params)", () => {
  it("emits reasoning_effort when reasoning is openai-effort and the value is supported", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({ apiKey: "k", model: "o3", capabilities: CAPS({ reasoning: "openai-effort" }), effort: "high", fetchImpl: captureFetch(cap) });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(cap.body!.reasoning_effort, "high");
  });
  it("drops effort when reasoning is 'none'", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ reasoning: "none" }), effort: "high", fetchImpl: captureFetch(cap) });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal("reasoning_effort" in cap.body!, false);
  });
  it("drops a non-OpenAI effort value (e.g. ultracode) even under openai-effort", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ reasoning: "openai-effort" }), effort: "ultracode", fetchImpl: captureFetch(cap) });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal("reasoning_effort" in cap.body!, false);
  });
  it("applies params.temperature + params.max_tokens (threaded-but-unapplied until M4)", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({}), params: { temperature: 0.2, max_tokens: 512 }, fetchImpl: captureFetch(cap) });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(cap.body!.temperature, 0.2);
    assert.equal(cap.body!.max_tokens, 512);
  });
  it("max_tokens falls back to capabilities.maxTokens", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ maxTokens: 4096 }), fetchImpl: captureFetch(cap) });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(cap.body!.max_tokens, 4096);
  });
  it("emits a response_format envelope (sanitized schema) for openai-response_format", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({
      apiKey: "k", model: "m", capabilities: CAPS({ structuredOutput: "openai-response_format" }),
      responseFormat: { name: "out", schema: { type: "object", properties: { n: { type: "number", minimum: 0 } }, required: ["n"] } },
      fetchImpl: captureFetch(cap),
    });
    await client.createTurn([{ role: "user", content: "hi" }]);
    const rf = cap.body!.response_format as { type: string; json_schema: { name: string; schema: Record<string, unknown> } };
    assert.equal(rf.type, "json_schema");
    assert.equal(rf.json_schema.name, "out");
    // numeric constraint stripped (lowest-common-denominator); type kept.
    const n = (rf.json_schema.schema.properties as Record<string, Record<string, unknown>>).n;
    assert.equal(n.type, "number");
    assert.equal("minimum" in n, false);
  });
  it("does not emit structured-output when capability is 'none'", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ structuredOutput: "none" }), responseFormat: { schema: { type: "object" } }, fetchImpl: captureFetch(cap) });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal("response_format" in cap.body!, false);
  });
});

describe("streamTurn capability gating", () => {
  it("exposes streamTurn by default and omits it when supportsStreaming:false", () => {
    const streaming = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ supportsStreaming: true }), fetchImpl: (async () => ({})) as unknown as typeof fetch });
    const nonStreaming = createOpenAIModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ supportsStreaming: false }), fetchImpl: (async () => ({})) as unknown as typeof fetch });
    assert.ok(streaming.streamTurn);
    assert.equal(nonStreaming.streamTurn, undefined);
  });
});
