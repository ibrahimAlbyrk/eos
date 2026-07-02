// AnthropicModelClient — a ModelClient over the Anthropic Messages API, for the
// anthropic-api backend (driven by the Eos ToolRuntime). Pure transport: maps the
// runtime's ModelMessage[] → Messages API request, parses content blocks (text /
// thinking / tool_use) + usage back into a ModelTurn. `fetch` is injectable so the
// mapping is unit-tested without a live (billed) call.
//
// M4 normalization (all CAPABILITY-driven — no model-name/kind branches):
//  • reasoningRoundTrip:"preserve-signed" — re-emit the signed `thinking` blocks on
//    each assistant tool-call message verbatim (Anthropic 400s otherwise).
//  • cache:"anthropic-explicit" — cache_control breakpoints on the stable prefix.
//  • streamTurn — a SEPARATE Anthropic SSE parser (gated on supportsStreaming).
//  • effort→thinking budget + capability-driven max_tokens + params.temperature.
//  • withRetry on 429/5xx (Retry-After); model_context_window_exceeded→typed error.
//
// Billing: this draws from the API-key pool, NOT the Max/Pro subscription —
// opt-in only, never the default (the claude-cli backend remains default).

import type { ModelClient, ModelMessage, ModelTurn, ModelStreamCallbacks } from "../../../core/src/ports/ModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";
import { normalizeBaseOrigin } from "./base-url.ts";
import { withRetry, resolveRetryPolicy, defaultSleep, type SleepFn } from "./with-retry.ts";
import { structuredOutputEnvelope, type StructuredRequest } from "./structured-output.ts";
import { INSUFFICIENT_CREDITS, AUTH_INVALID, type ProviderErrorInfo } from "./provider-error.ts";

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
  // M4 — declared provider quirks + per-worker params, read instead of heuristics.
  capabilities?: ProviderCapabilities;
  params?: Record<string, unknown>;
  effort?: string | null;
  responseFormat?: StructuredRequest;
  onProviderError?(e: ProviderErrorInfo): void;
  sleepImpl?: SleepFn;
}

// Recognize Anthropic's context-overflow 400 so the loop can compact + recover
// instead of treating it as a generic terminal error.
function isContextOverflow(text: string): boolean {
  return /model_context_window_exceeded|prompt is too long|context.{0,40}(window|length)|maximum.{0,20}context/i.test(text);
}

// Classify a non-OK Anthropic HTTP response into a typed error string (context/credit/
// auth), following the context_window_exceeded precedent; anything else keeps the raw
// `HTTP <status>: <text>` fallback so nothing is masked.
function classifyAnthropicError(status: number, text: string): string {
  if (status === 401) return AUTH_INVALID;
  if (status === 400) {
    if (isContextOverflow(text)) return "context_window_exceeded";
    if (/credit balance/i.test(text)) return INSUFFICIENT_CREDITS;
  }
  return `HTTP ${status}: ${text.slice(0, 200)}`;
}

function effortToBudget(effort: string): number {
  switch (effort) {
    case "low": return 2048;
    case "medium": return 8192;
    case "high":
    case "xhigh": return 16384;
    default: return 4096;
  }
}

export function createAnthropicModelClient(opts: AnthropicModelClientOpts): ModelClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = normalizeBaseOrigin(opts.baseUrl ?? "https://api.anthropic.com");
  const caps = opts.capabilities;
  const preserveSigned = caps?.reasoningRoundTrip === "preserve-signed";
  const supportsStreaming = caps?.supportsStreaming !== false;
  const cacheOn = caps?.cache === "anthropic-explicit";
  const retryPolicy = resolveRetryPolicy(caps?.retry);
  const sleep = opts.sleepImpl ?? defaultSleep;

  // Extended thinking (anthropic-thinking) — explicit params.thinking wins; else map
  // effort → a budget. Fixed per client (independent of the conversation).
  const thinking: Record<string, unknown> | undefined = (() => {
    if (caps?.reasoning !== "anthropic-thinking") return undefined;
    if (opts.params?.thinking && typeof opts.params.thinking === "object") return opts.params.thinking as Record<string, unknown>;
    if (!opts.effort) return undefined;
    return { type: "enabled", budget_tokens: effortToBudget(opts.effort) };
  })();
  const paramMax = typeof opts.params?.max_tokens === "number" ? (opts.params.max_tokens as number) : undefined;
  const budget = typeof thinking?.budget_tokens === "number" ? (thinking.budget_tokens as number) : 0;
  // Capability-driven max_tokens (the 4096 default is too low for reasoning); must
  // exceed the thinking budget when thinking is on.
  const maxTokens = Math.max(paramMax ?? caps?.maxTokens ?? opts.maxTokens ?? 4096, budget ? budget + 1024 : 0);
  // Anthropic forbids temperature with thinking enabled.
  const temperature = !thinking && typeof opts.params?.temperature === "number" ? (opts.params.temperature as number) : undefined;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    // Keyless (empty key) → omit x-api-key (an Anthropic-compatible localhost proxy
    // may need no key), mirroring the OpenAI lane's no-Authorization-when-keyless.
    ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
    "anthropic-version": opts.anthropicVersion ?? "2023-06-01",
  });

  const buildSystem = (): unknown => {
    if (!opts.system) return undefined;
    // cache_control on the system block caches the stable [tools, system] prefix.
    return cacheOn ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] : opts.system;
  };
  const buildTools = (): AnthropicToolSpec[] | undefined => {
    if (!opts.tools || !opts.tools.length) return undefined;
    if (!cacheOn) return opts.tools;
    // Breakpoint on the LAST tool caches the whole tool-schema prefix.
    return opts.tools.map((t, i) => (i === opts.tools!.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
  };

  const buildBody = (messages: ModelMessage[], stream: boolean): Record<string, unknown> => {
    const system = buildSystem();
    const tools = buildTools();
    return {
      model: opts.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(tools && tools.length ? { tools } : {}),
      ...(thinking ? { thinking } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...structuredOutputEnvelope(caps?.structuredOutput, opts.responseFormat),
      ...(stream ? { stream: true } : {}),
      messages: messages.map((m) => toAnthropicMessage(m, preserveSigned)),
    };
  };

  const post = (body: Record<string, unknown>, signal?: { aborted: boolean }) =>
    withRetry(
      () => doFetch(`${base}/v1/messages`, { method: "POST", headers: headers(), body: JSON.stringify(body) }),
      retryPolicy,
      sleep,
      signal,
    );

  const httpError = (status: number, text: string): ModelTurn => {
    opts.onProviderError?.({ transport: "http", status, detail: text.slice(0, 200) });
    return { toolCalls: [], stopReason: "error", error: classifyAnthropicError(status, text) };
  };
  const netError = (e: unknown): ModelTurn => {
    const msg = e instanceof Error ? e.message : String(e);
    opts.onProviderError?.({ transport: "network", detail: msg });
    return { toolCalls: [], stopReason: "error", error: msg };
  };

  const client: ModelClient = {
    async createTurn(messages: ModelMessage[]): Promise<ModelTurn> {
      let resp: Response;
      try {
        resp = await post(buildBody(messages, false));
      } catch (e) {
        return netError(e);
      }
      if (!resp.ok) return httpError(resp.status, await resp.text().catch(() => ""));
      return parseAnthropicResponse((await resp.json()) as AnthropicResponse);
    },
  };
  // ISP — only expose streamTurn when the provider streams (the loop falls back to
  // createTurn for known-broken parsers, supportsStreaming:false).
  if (supportsStreaming) {
    client.streamTurn = async (messages: ModelMessage[], cb: ModelStreamCallbacks): Promise<ModelTurn> => {
      let resp: Response;
      try {
        resp = await post(buildBody(messages, true), cb.signal);
      } catch (e) {
        return netError(e);
      }
      if (!resp.ok || !resp.body) {
        const t = resp.ok ? "no stream body" : await resp.text().catch(() => "");
        return resp.ok ? { toolCalls: [], stopReason: "error", error: "no stream body" } : httpError(resp.status, t);
      }
      return parseAnthropicStream(resp.body, cb);
    };
  }
  return client;
}

function toAnthropicMessage(m: ModelMessage, preserveSigned: boolean): { role: string; content: unknown } {
  if (m.role === "tool") {
    const c = m.content as { callId: string; result: string; isError?: boolean };
    return { role: "user", content: [{ type: "tool_result", tool_use_id: c.callId, content: c.result, is_error: !!c.isError }] };
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    const toolUse = (m.content as Array<{ callId: string; name: string; input: unknown }>).map((tc) => ({ type: "tool_use", id: tc.callId, name: tc.name, input: tc.input }));
    // reasoningRoundTrip:"preserve-signed" — prepend the verbatim signed thinking
    // block(s) before the tool_use blocks (the order + signature Anthropic requires).
    const thinking = preserveSigned && Array.isArray(m.providerMetadata?.anthropicThinking) ? (m.providerMetadata!.anthropicThinking as unknown[]) : [];
    return { role: "assistant", content: [...thinking, ...toolUse] };
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
  // Capture signed thinking blocks VERBATIM so reasoningRoundTrip:"preserve-signed"
  // can re-emit them next request (always captured; re-emit is gated in the mapper).
  const thinkingBlocks: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string") {
      reasoning += b.thinking;
      thinkingBlocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    } else if (b.type === "redacted_thinking" && typeof b.data === "string") {
      thinkingBlocks.push({ type: "redacted_thinking", data: b.data });
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
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
    ...(thinkingBlocks.length ? { providerMetadata: { anthropicThinking: thinkingBlocks } } : {}),
  };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
}

interface BlockState {
  type: string;
  toolId?: string;
  toolName?: string;
  data?: string;
  json: string;
  thinking: string;
  signature: string;
}

// Anthropic Messages SSE parser — SEPARATE from the OpenAI parser (it shares only
// the ModelStreamCallbacks contract). message_start → content_block_* → message_delta
// → message_stop. Tool input arrives as input_json_delta.partial_json accumulated
// per index and JSON-parsed at content_block_stop; thinking_delta + signature_delta
// rebuild the signed block; usage is cumulative (input on message_start, output on
// message_delta). The `event:` lines are ignored — each `data:` JSON carries `type`.
export async function parseAnthropicStream(body: ReadableStream<Uint8Array>, cb: ModelStreamCallbacks): Promise<ModelTurn> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let stopReason: string | undefined;
  let usage: ModelTurn["usage"];
  const blocks = new Map<number, BlockState>();
  const toolCalls: ModelTurn["toolCalls"] = [];
  const thinkingBlocks: Array<Record<string, unknown>> = [];

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
        let ev: AnthropicStreamEvent;
        try { ev = JSON.parse(payload); } catch { continue; }
        switch (ev.type) {
          case "message_start": {
            const u = ev.message?.usage;
            if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0 };
            break;
          }
          case "content_block_start": {
            const block = ev.content_block ?? {};
            blocks.set(ev.index ?? 0, { type: block.type ?? "", toolId: block.id, toolName: block.name, data: block.data, json: "", thinking: "", signature: "" });
            break;
          }
          case "content_block_delta": {
            const st = blocks.get(ev.index ?? 0) ?? { type: "", json: "", thinking: "", signature: "" };
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string") { text += d.text; cb.onTextDelta?.(d.text); }
            else if (d.type === "thinking_delta" && typeof d.thinking === "string") { reasoning += d.thinking; st.thinking += d.thinking; cb.onReasoningDelta?.(d.thinking); }
            else if (d.type === "signature_delta" && typeof d.signature === "string") { st.signature += d.signature; }
            else if (d.type === "input_json_delta" && typeof d.partial_json === "string") { st.json += d.partial_json; }
            blocks.set(ev.index ?? 0, st);
            break;
          }
          case "content_block_stop": {
            const st = blocks.get(ev.index ?? 0);
            if (st) {
              if (st.type === "tool_use" && st.toolName) {
                let input: Record<string, unknown> = {};
                try { input = st.json ? JSON.parse(st.json) : {}; } catch { input = {}; }
                toolCalls.push({ callId: st.toolId ?? "", name: st.toolName, input });
              } else if (st.type === "thinking") {
                thinkingBlocks.push({ type: "thinking", thinking: st.thinking, signature: st.signature });
              } else if (st.type === "redacted_thinking" && st.data) {
                thinkingBlocks.push({ type: "redacted_thinking", data: st.data });
              }
            }
            break;
          }
          case "message_delta": {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage) usage = { inputTokens: usage?.inputTokens ?? 0, outputTokens: ev.usage.output_tokens ?? usage?.outputTokens ?? 0, cacheReadTokens: usage?.cacheReadTokens ?? 0 };
            break;
          }
          default:
            break;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  // ModelTurn has no "aborted" stopReason — report a cancelled stream as the error
  // shape (ToolRuntime ends the turn on stopReason:"error"), mirroring the OpenAI parser.
  if (aborted) return { text: text || undefined, reasoning: reasoning || undefined, toolCalls: [], stopReason: "error", error: "aborted", usage };

  const finalStop = toolCalls.length > 0 ? "tool_use" : stopReason === "max_tokens" ? "max_tokens" : "end_turn";
  return {
    text: text || undefined,
    reasoning: reasoning || undefined,
    toolCalls,
    stopReason: finalStop,
    usage,
    ...(thinkingBlocks.length ? { providerMetadata: { anthropicThinking: thinkingBlocks } } : {}),
  };
}
