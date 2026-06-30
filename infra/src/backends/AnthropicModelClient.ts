// AnthropicModelClient — a ModelClient over the Anthropic Messages API, for the
// anthropic-api backend (driven by the Eos ToolRuntime). Pure transport: maps
// the runtime's ModelMessage[] → Messages API request, parses content blocks
// (text / thinking / tool_use) + usage back into a ModelTurn. `fetch` is
// injectable so the mapping is unit-tested without a live (billed) call.
//
// Billing: this draws from the API-key pool, NOT the Max/Pro subscription —
// opt-in only, never the default (the claude-cli backend remains default).

import type { ModelClient, ModelMessage, ModelTurn } from "../../../core/src/ports/ModelClient.ts";
import { normalizeBaseOrigin } from "./base-url.ts";

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicModelClientOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  system?: string;
  tools?: AnthropicToolSpec[];
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
}

export function createAnthropicModelClient(opts: AnthropicModelClientOpts): ModelClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = normalizeBaseOrigin(opts.baseUrl ?? "https://api.anthropic.com");
  return {
    async createTurn(messages: ModelMessage[]): Promise<ModelTurn> {
      const body = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
        messages: messages.map(toAnthropicMessage),
      };
      let resp: Response;
      try {
        resp = await doFetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": opts.anthropicVersion ?? "2023-06-01",
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { toolCalls: [], stopReason: "error", error: e instanceof Error ? e.message : String(e) };
      }
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        return { toolCalls: [], stopReason: "error", error: `HTTP ${resp.status}: ${t.slice(0, 200)}` };
      }
      return parseAnthropicResponse((await resp.json()) as AnthropicResponse);
    },
  };
}

function toAnthropicMessage(m: ModelMessage): { role: string; content: unknown } {
  if (m.role === "tool") {
    const c = m.content as { callId: string; result: string; isError?: boolean };
    return { role: "user", content: [{ type: "tool_result", tool_use_id: c.callId, content: c.result, is_error: !!c.isError }] };
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    return {
      role: "assistant",
      content: (m.content as Array<{ callId: string; name: string; input: unknown }>).map((tc) => ({ type: "tool_use", id: tc.callId, name: tc.name, input: tc.input })),
    };
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
}

interface AnthropicResponse {
  content?: Array<Record<string, unknown>>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export function parseAnthropicResponse(data: AnthropicResponse): ModelTurn {
  const blocks = Array.isArray(data.content) ? data.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls: ModelTurn["toolCalls"] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string") reasoning += b.thinking;
    else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      toolCalls.push({ callId: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    }
  }
  const raw = data.stop_reason;
  const stopReason = toolCalls.length > 0 ? "tool_use" : raw === "max_tokens" ? "max_tokens" : "end_turn";
  return {
    text: text || undefined,
    reasoning: reasoning || undefined,
    toolCalls,
    stopReason,
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0, cacheReadTokens: data.usage.cache_read_input_tokens ?? 0 }
      : undefined,
  };
}
