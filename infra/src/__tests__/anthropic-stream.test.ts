import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnthropicStream, createAnthropicModelClient } from "../backends/AnthropicModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

// The Anthropic Messages SSE parser is SEPARATE from the OpenAI one (06 §3.3):
// message_start → content_block_* → message_delta → message_stop; tool input via
// input_json_delta accumulated to content_block_stop; thinking_delta + signature_delta
// rebuild the signed block; usage is cumulative. `event:` lines are ignored.

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}

const FULL_TURN = [
  "event: message_start\n",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":8}}}\n',
  "event: content_block_start\n",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me "}}\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG-9"}}\n',
  'data: {"type":"content_block_stop","index":0}\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n',
  'data: {"type":"content_block_stop","index":1}\n',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu1","name":"Bash"}}\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\""}}\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":":\\"ls\\"}"}}\n',
  'data: {"type":"content_block_stop","index":2}\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n',
  'data: {"type":"message_stop"}\n',
];

describe("parseAnthropicStream", () => {
  it("aggregates thinking + text + tool_use, emits deltas, and captures the signed thinking block", async () => {
    const reasoning: string[] = [];
    const text: string[] = [];
    const turn = await parseAnthropicStream(sseStream(FULL_TURN), { onReasoningDelta: (t) => reasoning.push(t), onTextDelta: (t) => text.push(t) });
    assert.deepEqual(reasoning, ["let me ", "think"]);
    assert.deepEqual(text, ["Hi"]);
    assert.equal(turn.reasoning, "let me think");
    assert.equal(turn.text, "Hi");
    assert.equal(turn.stopReason, "tool_use");
    assert.deepEqual(turn.toolCalls, [{ callId: "tu1", name: "Bash", input: { command: "ls" } }]);
    // usage: input/cache from message_start, output from message_delta (cumulative).
    assert.deepEqual(turn.usage, { inputTokens: 20, outputTokens: 15, cacheReadTokens: 8 });
    // the signed thinking block is preserved verbatim for the round-trip carrier.
    assert.deepEqual(turn.providerMetadata?.anthropicThinking, [{ type: "thinking", thinking: "let me think", signature: "SIG-9" }]);
  });

  it("maps stop_reason:max_tokens and a plain text turn", async () => {
    const turn = await parseAnthropicStream(sseStream([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n',
      'data: {"type":"content_block_stop","index":0}\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4}}\n',
      'data: {"type":"message_stop"}\n',
    ]), {});
    assert.equal(turn.text, "done");
    assert.equal(turn.stopReason, "max_tokens");
    assert.equal(turn.toolCalls.length, 0);
    assert.equal(turn.providerMetadata, undefined, "no thinking block → no providerMetadata");
  });

  it("aborted stream returns error (not end_turn) and cancels the reader", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enc.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n')); },
      cancel() { cancelled = true; },
    });
    const sig = { aborted: false };
    const turn = await parseAnthropicStream(stream, { signal: sig, onTextDelta: () => { sig.aborted = true; } });
    assert.equal(turn.stopReason, "error");
    assert.equal(turn.error, "aborted");
    assert.equal(cancelled, true);
  });
});

describe("createAnthropicModelClient — streamTurn capability gating", () => {
  const CAPS = (over: Partial<ProviderCapabilities>): ProviderCapabilities => ({
    wire: "anthropic", supportsStreaming: true, supportsTools: true, supportsParallelToolCalls: true,
    reasoning: "none", reasoningRoundTrip: "preserve-signed", cache: "none", structuredOutput: "none", contextWindow: 200000, ...over,
  });

  it("exposes streamTurn when supportsStreaming and drives the Anthropic parser", async () => {
    const enc = new TextEncoder();
    const fetchImpl = (async () => ({
      ok: true, status: 200, headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({ start(c) { for (const ch of FULL_TURN) c.enqueue(enc.encode(ch)); c.close(); } }),
    })) as unknown as typeof fetch;
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: CAPS({}), fetchImpl });
    assert.ok(client.streamTurn, "streamTurn present");
    const turn = await client.streamTurn!([{ role: "user", content: "hi" }], {});
    assert.equal(turn.stopReason, "tool_use");
    assert.deepEqual(turn.toolCalls[0], { callId: "tu1", name: "Bash", input: { command: "ls" } });
  });

  it("omits streamTurn when supportsStreaming:false (loop falls back to createTurn)", () => {
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: CAPS({ supportsStreaming: false }), fetchImpl: (async () => ({})) as unknown as typeof fetch });
    assert.equal(client.streamTurn, undefined);
  });
});
