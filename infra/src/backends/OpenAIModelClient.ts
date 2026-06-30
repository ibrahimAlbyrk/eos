// OpenAIModelClient — a ModelClient over the OpenAI Chat Completions API, which
// also covers Codex-via-API and any OpenAI-compatible endpoint (baseUrl
// override). Same role as AnthropicModelClient: maps the ToolRuntime's
// ModelMessage[] → request and parses the response → ModelTurn. fetch is
// injectable so the mapping is unit-tested with no live (billed) call.
//
// Billing: API-key pool, opt-in; never the default.

import type { ModelClient, ModelMessage, ModelTurn, ModelStreamCallbacks } from "../../../core/src/ports/ModelClient.ts";
import { normalizeBaseOrigin } from "./base-url.ts";

export interface OpenAIToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIModelClientOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  system?: string;
  tools?: OpenAIToolSpec[];
  fetchImpl?: typeof fetch;
}

export function createOpenAIModelClient(opts: OpenAIModelClientOpts): ModelClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = normalizeBaseOrigin(opts.baseUrl ?? "https://api.openai.com");
  // Keyless localhost (Ollama/vLLM/LM Studio, AuthRef.kind:"none"): an empty key
  // means send NO Authorization header — a `Bearer ` with no token 401s on some
  // servers and is meaningless on local ones.
  const headers = (): Record<string, string> =>
    opts.apiKey
      ? { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` }
      : { "content-type": "application/json" };
  return {
    async createTurn(messages: ModelMessage[]): Promise<ModelTurn> {
      const mapped = messages.map(toOpenAIMessage);
      const body = {
        model: opts.model,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.tools && opts.tools.length ? { tools: opts.tools.map((t) => ({ type: "function", function: t })) } : {}),
        messages: opts.system ? [{ role: "system", content: opts.system }, ...mapped] : mapped,
      };
      let resp: Response;
      try {
        resp = await doFetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { toolCalls: [], stopReason: "error", error: e instanceof Error ? e.message : String(e) };
      }
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        return { toolCalls: [], stopReason: "error", error: `HTTP ${resp.status}: ${t.slice(0, 200)}` };
      }
      return parseOpenAIResponse((await resp.json()) as OpenAIResponse);
    },
    async streamTurn(messages: ModelMessage[], cb: ModelStreamCallbacks): Promise<ModelTurn> {
      const mapped = messages.map(toOpenAIMessage);
      const body = {
        model: opts.model,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.tools && opts.tools.length ? { tools: opts.tools.map((t) => ({ type: "function", function: t })) } : {}),
        messages: opts.system ? [{ role: "system", content: opts.system }, ...mapped] : mapped,
      };
      let resp: Response;
      try {
        resp = await doFetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { toolCalls: [], stopReason: "error", error: e instanceof Error ? e.message : String(e) };
      }
      if (!resp.ok || !resp.body) {
        const t = resp.ok ? "no stream body" : await resp.text().catch(() => "");
        return { toolCalls: [], stopReason: "error", error: `HTTP ${resp.status}: ${t.slice(0, 200)}` };
      }
      return parseOpenAIStream(resp.body, cb);
    },
  };
}

function toOpenAIMessage(m: ModelMessage): Record<string, unknown> {
  if (m.role === "tool") {
    const c = m.content as { callId: string; result: string };
    return { role: "tool", tool_call_id: c.callId, content: c.result };
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    return {
      role: "assistant",
      tool_calls: (m.content as Array<{ callId: string; name: string; input: unknown }>).map((tc) => ({
        id: tc.callId,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    };
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
}

interface OpenAIResponse {
  choices?: Array<{
    // reasoning_content is the DeepSeek/Kimi reasoning field (OpenAI-compatible
    // extension); maps to the canonical reasoning channel.
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  // prompt_tokens_details.cached_tokens is the OpenAI/DeepSeek prompt-cache hit
  // count → the canonical cacheReadTokens (was always 0 on this lane before).
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export function parseOpenAIResponse(data: OpenAIResponse): ModelTurn {
  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: ModelTurn["toolCalls"] = [];
  for (const tc of msg.tool_calls ?? []) {
    if (!tc.function?.name) continue;
    let input: Record<string, unknown> = {};
    try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
    toolCalls.push({ callId: tc.id ?? "", name: tc.function.name, input });
  }
  const fr = choice?.finish_reason;
  const stopReason = toolCalls.length > 0 ? "tool_use" : fr === "length" ? "max_tokens" : "end_turn";
  return {
    text: typeof msg.content === "string" && msg.content ? msg.content : undefined,
    reasoning: typeof msg.reasoning_content === "string" && msg.reasoning_content ? msg.reasoning_content : undefined,
    toolCalls,
    stopReason,
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0, cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0 }
      : undefined,
  };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
}

// Drain an OpenAI-compatible SSE stream into a ModelTurn, emitting reasoning/text
// deltas live. tool_calls stream as fragments (index + partial arguments) and are
// buffered per index, then JSON-parsed once complete.
export async function parseOpenAIStream(body: ReadableStream<Uint8Array>, cb: ModelStreamCallbacks): Promise<ModelTurn> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: ModelTurn["usage"];
  const toolsByIndex = new Map<number, { id: string; name: string; args: string }>();

  // reader.cancel() cancels the underlying fetch body/socket AND releases the
  // lock, so finally covers every exit (a cancel after full drain is harmless).
  let aborted = false;
  try {
    for (;;) {
      if (cb.signal?.aborted) { aborted = true; break; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: OpenAIStreamChunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0, cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta ?? {};
        if (typeof d.reasoning_content === "string" && d.reasoning_content) { reasoning += d.reasoning_content; cb.onReasoningDelta?.(d.reasoning_content); }
        if (typeof d.content === "string" && d.content) { text += d.content; cb.onTextDelta?.(d.content); }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = toolsByIndex.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolsByIndex.set(idx, cur);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  // ModelTurn has no "aborted" stopReason — report a cancelled stream as the
  // file's existing error shape (ToolRuntime ends the turn on stopReason:"error").
  if (aborted) return { text: text || undefined, reasoning: reasoning || undefined, toolCalls: [], stopReason: "error", error: "aborted", usage };

  const toolCalls: ModelTurn["toolCalls"] = [];
  for (const t of toolsByIndex.values()) {
    if (!t.name) continue;
    let input: Record<string, unknown> = {};
    try { input = t.args ? JSON.parse(t.args) : {}; } catch { input = {}; }
    toolCalls.push({ callId: t.id, name: t.name, input });
  }
  const stopReason = toolCalls.length > 0 ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";
  return { text: text || undefined, reasoning: reasoning || undefined, toolCalls, stopReason, usage };
}
