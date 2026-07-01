import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIModelClient, parseOpenAIResponse } from "../backends/OpenAIModelClient.ts";
import type { ModelMessage } from "../../../core/src/ports/ModelClient.ts";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

describe("OpenAIModelClient", () => {
  it("builds a chat/completions request (bearer auth, function tools, mapped messages)", async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const fetchImpl = (async (url: string, init: FetchInit) => {
      cap.url = url; cap.init = init;
      return { ok: true, async json() { return { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }; } } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createOpenAIModelClient({
      apiKey: "sk-o", model: "gpt-5", baseUrl: "https://proxy.local",
      tools: [{ name: "echo", description: "e", parameters: { type: "object" } }],
      fetchImpl,
    });
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ callId: "t1", name: "echo", input: { a: 1 } }] },
      { role: "tool", content: { callId: "t1", result: "ok" } },
    ];
    await client.createTurn(messages);
    assert.match(cap.url!, /^https:\/\/proxy\.local\/v1\/chat\/completions$/);
    assert.equal((cap.init!.headers as Record<string, string>).authorization, "Bearer sk-o");
    const body = JSON.parse(cap.init!.body as string);
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.messages[1].tool_calls[0].function.name, "echo");
    assert.equal(body.messages[2].role, "tool");
    assert.equal(body.messages[2].tool_call_id, "t1");
  });

  it("parses tool_calls (arguments JSON) into ModelTurn", () => {
    const turn = parseOpenAIResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: "call_1", function: { name: "run", arguments: '{"cmd":"ls"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 50, completion_tokens: 8 },
    });
    assert.equal(turn.stopReason, "tool_use");
    assert.deepEqual(turn.toolCalls, [{ callId: "call_1", name: "run", input: { cmd: "ls" } }]);
    assert.equal(turn.usage?.inputTokens, 50);
  });

  it("parses a plain text completion", () => {
    const turn = parseOpenAIResponse({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
    assert.equal(turn.text, "done");
    assert.equal(turn.toolCalls.length, 0);
    assert.equal(turn.stopReason, "end_turn");
  });

  it("reads cached_tokens into cacheReadTokens AND excludes them from inputTokens (bill once)", () => {
    // prompt_tokens (100) INCLUDES the cached slice (60). inputTokens must report the
    // non-cached 40 so cost = 40·in + 60·cacheRead — not 100·in + 60·cacheRead, which
    // double-bills the cached tokens at the full input rate.
    const turn = parseOpenAIResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } },
    });
    assert.equal(turn.usage?.cacheReadTokens, 60);
    assert.equal(turn.usage?.inputTokens, 40);
  });

  it("authStyle x-goog-api-key sends the key in that header and NO Authorization", async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const fetchImpl = (async (url: string, init: FetchInit) => {
      cap.url = url; cap.init = init;
      return { ok: true, async json() { return { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }; } } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createOpenAIModelClient({
      apiKey: "AIza-key", model: "gemini-3.1-pro-preview",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      capabilities: { wire: "openai-chat", contextWindow: 1_000_000, authStyle: "x-goog-api-key", chatCompletionsPath: "/chat/completions" },
      fetchImpl,
    });
    await client.createTurn([{ role: "user", content: "hi" }]);
    const h = cap.init!.headers as Record<string, string>;
    assert.equal(h["x-goog-api-key"], "AIza-key");
    assert.equal(h.authorization, undefined);
    // chatCompletionsPath composes onto the origin-only base verbatim.
    assert.equal(cap.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  });

  it("chatCompletionsPath overrides the /v1 default (Zhipu)", async () => {
    const cap: { url?: string } = {};
    const fetchImpl = (async (url: string) => {
      cap.url = url;
      return { ok: true, async json() { return { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }; } } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createOpenAIModelClient({
      apiKey: "k", model: "glm-5.2", baseUrl: "https://api.z.ai",
      capabilities: { wire: "openai-chat", contextWindow: 200_000, chatCompletionsPath: "/api/paas/v4/chat/completions" },
      fetchImpl,
    });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal(cap.url, "https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("keyless (empty apiKey) sends NO Authorization header", async () => {
    const cap: { init?: FetchInit } = {};
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      cap.init = init;
      return { ok: true, async json() { return { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }; } } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createOpenAIModelClient({ apiKey: "", model: "llama3", baseUrl: "http://localhost:11434", fetchImpl });
    await client.createTurn([{ role: "user", content: "hi" }]);
    assert.equal((cap.init!.headers as Record<string, string>).authorization, undefined);
  });

  it("tolerates malformed tool arguments (no throw)", () => {
    const turn = parseOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "{not json" } }] }, finish_reason: "tool_calls" }] });
    assert.deepEqual(turn.toolCalls[0].input, {});
  });

  it("surfaces a non-retryable HTTP status as a model error", async () => {
    // 401 is non-retryable → returned straight to the caller (429/5xx now retry, M4).
    const client = createOpenAIModelClient({ apiKey: "k", model: "m", fetchImpl: (async () => ({ ok: false, status: 401, async text() { return "unauthorized"; } })) as unknown as typeof fetch });
    const turn = await client.createTurn([{ role: "user", content: "x" }]);
    assert.equal(turn.stopReason, "error");
    assert.match(turn.error ?? "", /401/);
  });
});
