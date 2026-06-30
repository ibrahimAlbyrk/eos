import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicModelClient } from "../backends/AnthropicModelClient.ts";
import { createOpenAIModelClient } from "../backends/OpenAIModelClient.ts";
import { runTurn, type ToolGate, type RuntimeTool } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

// THE #1 cross-provider hazard, OPPOSITE across providers (06 §4.4):
//   • Anthropic 400s if signed `thinking` blocks are NOT preserved across tool turns.
//   • DeepSeek/OpenAI 400 if `reasoning_content` IS echoed back into history.
// Both behaviors are driven by ProviderCapabilities.reasoningRoundTrip. Each fake
// endpoint MIMICS the real 400 so a regression surfaces as a turn:error, not a silent
// shape change. Driven through the real ToolRuntime loop ("across tool turns").

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type Json = Record<string, unknown>;

function res(status: number, bodyObj: Json): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: null,
    async json() { return bodyObj; },
    async text() { return JSON.stringify(bodyObj); },
  } as unknown as Response;
}

const allowGate: ToolGate = { async decide() { return { allow: true }; } };
const echoTool: RuntimeTool = { name: "echo", async execute() { return "tool-result"; } };

function harness() {
  const events: AgentEvent[] = [];
  const tools = new Map<string, RuntimeTool>([["echo", echoTool]]);
  return { events, tools, gate: allowGate, emit: (e: AgentEvent) => events.push(e) };
}

const ANTHROPIC: ProviderCapabilities = {
  wire: "anthropic", supportsStreaming: false, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "anthropic-thinking", reasoningRoundTrip: "preserve-signed", cache: "none", structuredOutput: "none", contextWindow: 200000,
};
const DEEPSEEK: ProviderCapabilities = {
  wire: "openai-chat", supportsStreaming: false, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "reasoning_content", reasoningRoundTrip: "drop", cache: "automatic", structuredOutput: "none", contextWindow: 65536,
};

describe("reasoning round-trip — Anthropic PRESERVES signed thinking across tool turns", () => {
  it("re-emits the signed thinking block on the assistant tool-call message (no 400)", async () => {
    let call = 0;
    let secondTurnHadThinking = false;
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      call++;
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: unknown }> };
      if (call === 1) {
        return res(200, {
          content: [
            { type: "thinking", thinking: "let me think", signature: "SIG-1" },
            { type: "tool_use", id: "tu1", name: "echo", input: { x: 1 } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      // Turn 2: the assistant tool_use message MUST carry the verbatim signed block,
      // before the tool_use, or the real API 400s.
      const asst = body.messages.find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Json[]).some((b) => b.type === "tool_use"));
      const blocks = (asst?.content ?? []) as Json[];
      secondTurnHadThinking = blocks.some((b) => b.type === "thinking" && b.signature === "SIG-1");
      // thinking block must come BEFORE the tool_use (Anthropic ordering rule).
      const thinkIdx = blocks.findIndex((b) => b.type === "thinking");
      const toolIdx = blocks.findIndex((b) => b.type === "tool_use");
      if (!secondTurnHadThinking || thinkIdx > toolIdx) return res(400, { error: { message: "thinking block missing or out of order" } });
      return res(200, { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 3 } });
    }) as unknown as typeof fetch;

    const client = createAnthropicModelClient({ apiKey: "k", model: "claude-x", capabilities: ANTHROPIC, fetchImpl });
    const h = harness();
    await runTurn({ model: client, tools: h.tools, gate: h.gate, emit: h.emit }, [{ role: "user", content: "go" }]);

    assert.equal(call, 2, "two model round-trips (tool turn + final)");
    assert.ok(secondTurnHadThinking, "the signed thinking block was re-emitted");
    assert.ok(h.events.some((e) => e.type === "turn" && e.phase === "ended"), "turn ended cleanly (no 400)");
    assert.ok(!h.events.some((e) => e.type === "turn" && e.phase === "error"), "no turn error");
  });

  it("does NOT re-emit thinking when capability is 'drop' (would be wrong for Anthropic, proving it is capability-driven)", async () => {
    let secondTurnHadThinking = true;
    let call = 0;
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      call++;
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: unknown }> };
      if (call === 1) {
        return res(200, { content: [{ type: "thinking", thinking: "x", signature: "SIG" }, { type: "tool_use", id: "t", name: "echo", input: {} }], stop_reason: "tool_use" });
      }
      const asst = body.messages.find((m) => m.role === "assistant" && Array.isArray(m.content));
      secondTurnHadThinking = ((asst?.content ?? []) as Json[]).some((b) => b.type === "thinking");
      return res(200, { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    }) as unknown as typeof fetch;
    const client = createAnthropicModelClient({ apiKey: "k", model: "m", capabilities: { ...ANTHROPIC, reasoningRoundTrip: "drop" }, fetchImpl });
    const h = harness();
    await runTurn({ model: client, tools: h.tools, gate: h.gate, emit: h.emit }, [{ role: "user", content: "go" }]);
    assert.equal(secondTurnHadThinking, false, "with 'drop', the thinking block is NOT re-emitted");
  });
});

describe("reasoning round-trip — DeepSeek/OpenAI STRIP reasoning from history", () => {
  it("never echoes reasoning_content into an assistant message (no 400)", async () => {
    let call = 0;
    let reasoningLeaked = false;
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      call++;
      const body = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> };
      // DeepSeek 400s if reasoning_content is echoed back on any assistant message.
      if (body.messages.some((m) => m.role === "assistant" && "reasoning_content" in m)) {
        reasoningLeaked = true;
        return res(400, { error: { message: "reasoning_content must not be echoed back" } });
      }
      if (call === 1) {
        return res(200, {
          choices: [{ message: { reasoning_content: "deep thought", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      return res(200, { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    }) as unknown as typeof fetch;

    const client = createOpenAIModelClient({ apiKey: "k", model: "deepseek-chat", capabilities: DEEPSEEK, fetchImpl });
    const h = harness();
    await runTurn({ model: client, tools: h.tools, gate: h.gate, emit: h.emit }, [{ role: "user", content: "go" }]);

    assert.equal(call, 2, "two model round-trips");
    assert.equal(reasoningLeaked, false, "reasoning was stripped from history");
    assert.ok(h.events.some((e) => e.type === "turn" && e.phase === "ended"), "turn ended cleanly (no 400)");
    assert.ok(!h.events.some((e) => e.type === "turn" && e.phase === "error"), "no turn error");
  });
});
