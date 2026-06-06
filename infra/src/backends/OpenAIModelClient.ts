// OpenAIModelClient — a ModelClient over the OpenAI Chat Completions API, which
// also covers Codex-via-API and any OpenAI-compatible endpoint (baseUrl
// override). Same role as AnthropicModelClient: maps the ToolRuntime's
// ModelMessage[] → request and parses the response → ModelTurn. fetch is
// injectable so the mapping is unit-tested with no live (billed) call.
//
// Billing: API-key pool, opt-in; never the default.

import type { ModelClient, ModelMessage, ModelTurn } from "../../../core/src/ports/ModelClient.ts";

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
  const base = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
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
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
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
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    toolCalls,
    stopReason,
    usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : undefined,
  };
}
