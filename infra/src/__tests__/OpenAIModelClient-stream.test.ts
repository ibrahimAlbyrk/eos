import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOpenAIResponse, parseOpenAIStream } from "../backends/OpenAIModelClient.ts";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
}

describe("OpenAIModelClient — reasoning_content (DeepSeek/Kimi)", () => {
  it("parseOpenAIResponse surfaces reasoning_content as canonical reasoning", () => {
    const turn = parseOpenAIResponse({
      choices: [{ message: { content: "the answer", reasoning_content: "step by step" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    });
    assert.equal(turn.text, "the answer");
    assert.equal(turn.reasoning, "step by step");
    assert.equal(turn.stopReason, "end_turn");
    assert.deepEqual(turn.usage, { inputTokens: 9, outputTokens: 4 });
  });
});

describe("parseOpenAIStream — SSE reasoning/text deltas + tool-call fragments", () => {
  it("emits reasoning then text deltas and aggregates the turn", async () => {
    const reasoning: string[] = [];
    const text: string[] = [];
    const turn = await parseOpenAIStream(
      sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"let me "}}]}\n',
        'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n',
        'data: {"choices":[{"delta":{"content":"ans"}}]}\n',
        'data: {"choices":[{"delta":{"content":"wer"}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        'data: {"usage":{"prompt_tokens":5,"completion_tokens":3}}\n',
        "data: [DONE]\n",
      ]),
      { onReasoningDelta: (t) => reasoning.push(t), onTextDelta: (t) => text.push(t) },
    );
    assert.deepEqual(reasoning, ["let me ", "think"]);
    assert.deepEqual(text, ["ans", "wer"]);
    assert.equal(turn.reasoning, "let me think");
    assert.equal(turn.text, "answer");
    assert.equal(turn.stopReason, "end_turn");
    assert.deepEqual(turn.usage, { inputTokens: 5, outputTokens: 3 });
  });

  it("aborted stream returns error (not end_turn) and cancels the reader", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n')); },
      cancel() { cancelled = true; },
    });
    const sig = { aborted: false };
    const text: string[] = [];
    const turn = await parseOpenAIStream(stream, {
      signal: sig,
      onTextDelta: (t) => { text.push(t); sig.aborted = true; },
    });
    assert.equal(turn.stopReason, "error");
    assert.equal(turn.error, "aborted");
    assert.notEqual(turn.stopReason, "end_turn");
    assert.equal(cancelled, true);
  });

  it("buffers tool_call argument fragments across chunks", async () => {
    const turn = await parseOpenAIStream(
      sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{\\"file"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"/x\\"}"}}]}}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
        "data: [DONE]\n",
      ]),
      {},
    );
    assert.equal(turn.stopReason, "tool_use");
    assert.deepEqual(turn.toolCalls, [{ callId: "c1", name: "Read", input: { file_path: "/x" } }]);
  });
});
