// OpenAIModelClient — a ModelClient over the OpenAI Chat Completions API, which
// also covers Codex-via-API and any OpenAI-compatible endpoint (baseUrl override:
// DeepSeek/GLM/Ollama/vLLM/LM Studio/LiteLLM/OpenRouter). Maps the ToolRuntime's
// ModelMessage[] → request and parses the response → ModelTurn. fetch is injectable
// so the mapping is unit-tested with no live (billed) call.
//
// M4 normalization (all CAPABILITY-driven — no model-name/kind branches):
//  • reasoningRoundTrip:"drop" — reasoning is never echoed into history (DeepSeek
//    400s otherwise); this is the default and the mapper simply omits it.
//  • token accounting — prompt_tokens_details.cached_tokens (OpenAI) AND
//    prompt_cache_hit_tokens (DeepSeek) → cacheReadTokens.
//  • effort→reasoning_effort, params.temperature/max_tokens, structured output —
//    emitted only when the capability supports them (droppable, the LiteLLM lesson).
//  • robust streamed tool-deltas (tolerate missing index/id) + supportsStreaming
//    gating (prefer non-streaming for known-broken parsers).
//  • withRetry on 429/5xx (Retry-After).
//
// Billing: API-key pool, opt-in; never the default.

import type { ModelClient, ModelMessage, ModelTurn, ModelStreamCallbacks } from "../../../core/src/ports/ModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";
import { normalizeBaseOrigin, DEFAULT_CHAT_COMPLETIONS_PATH } from "./base-url.ts";
import { withRetry, resolveRetryPolicy, defaultSleep, type SleepFn } from "./with-retry.ts";
import { structuredOutputEnvelope, type StructuredRequest } from "./structured-output.ts";
import { INSUFFICIENT_CREDITS, AUTH_INVALID, type ProviderErrorInfo } from "./provider-error.ts";

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
  // M4 — declared provider quirks + per-worker params, read instead of heuristics.
  capabilities?: ProviderCapabilities;
  params?: Record<string, unknown>;
  effort?: string | null;
  responseFormat?: StructuredRequest;
  onProviderError?(e: ProviderErrorInfo): void;
  sleepImpl?: SleepFn;
}

// OpenAI o-series reasoning_effort accepts these; anything else (TUI-only
// "ultracode"/"auto") is dropped rather than risking a 400.
const OPENAI_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

// Default cap on the gap between streamed chunks before the parser gives up on a
// stalled stream (see streamIdleTimeoutMs). Generous enough not to trip a slow
// reasoning model's server-side think pause, tight enough that a dead socket can't
// wedge the turn indefinitely. Overridable per-provider via the capability.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

// Classify a non-OK OpenAI-compatible HTTP response into a typed error string
// (credit/auth); anything else keeps the raw `HTTP <status>: <text>` fallback so
// nothing is masked. Mirrors the Anthropic client's classifier — same typed strings.
function classifyOpenAIError(status: number, text: string): string {
  if (status === 401) return AUTH_INVALID;
  if (status === 429 && /insufficient_quota/i.test(text)) return INSUFFICIENT_CREDITS;
  return `HTTP ${status}: ${text.slice(0, 200)}`;
}

export function createOpenAIModelClient(opts: OpenAIModelClientOpts): ModelClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = normalizeBaseOrigin(opts.baseUrl ?? "https://api.openai.com");
  const caps = opts.capabilities;
  const chatPath = caps?.chatCompletionsPath ?? DEFAULT_CHAT_COMPLETIONS_PATH;
  const supportsStreaming = caps?.supportsStreaming !== false;
  const retryPolicy = resolveRetryPolicy(caps?.retry);
  const sleep = opts.sleepImpl ?? defaultSleep;
  const streamIdleTimeoutMs = caps?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  const paramMax = typeof opts.params?.max_tokens === "number" ? (opts.params.max_tokens as number) : undefined;
  const maxTokens = paramMax ?? caps?.maxTokens ?? opts.maxTokens;
  const temperature = typeof opts.params?.temperature === "number" ? (opts.params.temperature as number) : undefined;
  // reasoning_effort only when the provider exposes openai-effort AND the value is
  // one OpenAI accepts (capability-gated/droppable).
  const reasoningEffort = caps?.reasoning === "openai-effort" && opts.effort && OPENAI_EFFORTS.has(opts.effort) ? opts.effort : undefined;
  // Output-token cap key: `max_tokens` by default, `max_completion_tokens` where the
  // provider declares it (gpt-5.x on /v1/chat/completions rejects `max_tokens`).
  const maxTokensParam = caps?.maxTokensParam ?? "max_tokens";
  // gpt-5.x on /v1/chat/completions 400s when reasoning_effort rides along with
  // function tools; the provider declares the incompatibility and we drop effort only
  // on tool-bearing requests (capability-gated — every other provider unchanged).
  const toolsPresent = Boolean(opts.tools && opts.tools.length);
  const effortForBody = toolsPresent && caps?.dropReasoningEffortWithTools ? undefined : reasoningEffort;

  // Keyless localhost (Ollama/vLLM/LM Studio, AuthRef.kind:"none"): an empty key
  // means send NO auth header — a `Bearer ` with no token 401s on some servers and
  // is meaningless on local ones. authStyle picks the header: "x-goog-api-key"
  // (Gemini) sends the key in that header and NO Authorization; anything else (the
  // omitted-default) sends `Authorization: Bearer <key>`.
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (!opts.apiKey) return h;
    if (caps?.authStyle === "x-goog-api-key") h["x-goog-api-key"] = opts.apiKey;
    else h.authorization = `Bearer ${opts.apiKey}`;
    return h;
  };

  const buildBody = (messages: ModelMessage[], stream: boolean): Record<string, unknown> => {
    const mapped = messages.map(toOpenAIMessage);
    return {
      model: opts.model,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(maxTokens ? { [maxTokensParam]: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(effortForBody ? { reasoning_effort: effortForBody } : {}),
      ...structuredOutputEnvelope(caps?.structuredOutput, opts.responseFormat),
      ...(opts.tools && opts.tools.length ? { tools: opts.tools.map((t) => ({ type: "function", function: t })) } : {}),
      messages: opts.system ? [{ role: "system", content: opts.system }, ...mapped] : mapped,
    };
  };

  const post = (body: Record<string, unknown>, signal?: { aborted: boolean }) =>
    withRetry(
      () => doFetch(`${base}${chatPath}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }),
      retryPolicy,
      sleep,
      signal,
    );

  const httpError = (status: number, text: string): ModelTurn => {
    opts.onProviderError?.({ transport: "http", status, detail: text.slice(0, 200) });
    return { toolCalls: [], stopReason: "error", error: classifyOpenAIError(status, text) };
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
      return parseOpenAIResponse((await resp.json()) as OpenAIResponse);
    },
  };
  if (supportsStreaming) {
    client.streamTurn = async (messages: ModelMessage[], cb: ModelStreamCallbacks): Promise<ModelTurn> => {
      let resp: Response;
      try {
        resp = await post(buildBody(messages, true), cb.signal);
      } catch (e) {
        return netError(e);
      }
      if (!resp.ok || !resp.body) {
        return resp.ok ? { toolCalls: [], stopReason: "error", error: "no stream body" } : httpError(resp.status, await resp.text().catch(() => ""));
      }
      return parseOpenAIStream(resp.body, cb, streamIdleTimeoutMs);
    };
  }
  return client;
}

function toOpenAIMessage(m: ModelMessage): Record<string, unknown> {
  if (m.role === "tool") {
    const c = m.content as { callId: string; result: string };
    return { role: "tool", tool_call_id: c.callId, content: c.result };
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    // reasoningRoundTrip:"drop" — only tool_calls go back, never reasoning_content.
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

// prompt_tokens_details.cached_tokens (OpenAI) OR prompt_cache_hit_tokens (DeepSeek)
// → the canonical cacheReadTokens.
function cacheRead(u: { prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number } | null | undefined): number {
  return u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
}

// The BILLABLE (non-cached) input. OpenAI/DeepSeek report prompt_tokens with the
// cached tokens INCLUDED; cacheReadTokens reports them again at the (discounted)
// cache rate. Reporting prompt_tokens verbatim as inputTokens double-bills the
// cached slice (full input rate + cache rate). Subtract them here so inputTokens is
// the non-cached input — matching Anthropic's input_tokens — and the cost engine
// reconstructs the full prompt size (for tiered thresholds) as inputTokens +
// cacheReadTokens.
function billableInput(u: OpenAIUsage | null | undefined): number {
  return Math.max(0, (u?.prompt_tokens ?? 0) - cacheRead(u));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

interface OpenAIResponse {
  choices?: Array<{
    // reasoning_content is the DeepSeek/Kimi reasoning field (OpenAI-compatible
    // extension); maps to the canonical reasoning channel.
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: OpenAIUsage;
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
      ? { inputTokens: billableInput(data.usage), outputTokens: data.usage.completion_tokens ?? 0, cacheReadTokens: cacheRead(data.usage) }
      : undefined,
  };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
}

// Read the next chunk, but give up after idleMs of silence — a stalled stream (a
// socket held open with no further data, or one that never sends [DONE]) would
// otherwise wedge the drain forever. Returns the STALLED sentinel on timeout; the
// orphaned read() settles harmlessly when the caller cancels the reader.
const STALLED = Symbol("stream-stalled");
type StreamRead = { done: boolean; value?: Uint8Array };
function readOrStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<StreamRead | typeof STALLED> {
  if (!(idleMs > 0)) return reader.read();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(STALLED); } }, idleMs);
    reader.read().then(
      (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(STALLED); } },
    );
  });
}

// Drain an OpenAI-compatible SSE stream into a ModelTurn, emitting reasoning/text
// deltas live. tool_calls stream as fragments and are buffered per index; a server
// that omits `index`/`id` (some OpenAI-compatible endpoints) is tolerated by
// allocating a slot on each new id and continuing the most recent slot otherwise.
// Terminates the drain on the `[DONE]` sentinel (some endpoints keep the socket
// open afterward) and on an idle-timeout stall, so the turn always settles.
export async function parseOpenAIStream(body: ReadableStream<Uint8Array>, cb: ModelStreamCallbacks, idleTimeoutMs = 0): Promise<ModelTurn> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: ModelTurn["usage"];
  const toolsByIndex = new Map<number, { id: string; name: string; args: string }>();
  let lastIdx = -1;

  // reader.cancel() cancels the underlying fetch body/socket AND releases the
  // lock, so finally covers every exit (a cancel after full drain is harmless).
  let aborted = false;
  let stalled = false;
  let sawDone = false;
  try {
    for (;;) {
      if (cb.signal?.aborted) { aborted = true; break; }
      const read = await readOrStall(reader, idleTimeoutMs);
      if (read === STALLED) { stalled = true; break; }
      const { done, value } = read;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        // Terminal sentinel: stop draining now — an endpoint that holds the socket
        // open after [DONE] would otherwise hang the read loop forever.
        if (payload === "[DONE]") { sawDone = true; break; }
        let chunk: OpenAIStreamChunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) usage = { inputTokens: billableInput(chunk.usage), outputTokens: chunk.usage.completion_tokens ?? 0, cacheReadTokens: cacheRead(chunk.usage) };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta ?? {};
        if (typeof d.reasoning_content === "string" && d.reasoning_content) { reasoning += d.reasoning_content; cb.onReasoningDelta?.(d.reasoning_content); }
        if (typeof d.content === "string" && d.content) { text += d.content; cb.onTextDelta?.(d.content); }
        for (const tc of d.tool_calls ?? []) {
          // Tolerate a missing index: a new id opens the next slot; a bare
          // continuation fragment appends to the most recent slot.
          const idx = typeof tc.index === "number" ? tc.index : tc.id ? lastIdx + 1 : Math.max(lastIdx, 0);
          lastIdx = Math.max(lastIdx, idx);
          const cur = toolsByIndex.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolsByIndex.set(idx, cur);
        }
      }
      if (sawDone) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  // ModelTurn has no "aborted" stopReason — report a cancelled stream as the
  // file's existing error shape (ToolRuntime ends the turn on stopReason:"error").
  if (aborted) return { text: text || undefined, reasoning: reasoning || undefined, toolCalls: [], stopReason: "error", error: "aborted", usage };
  // A stalled stream is likewise an error, not a clean end — surface any partial
  // text/reasoning so the durable block still lands, but stop the turn.
  if (stalled) return { text: text || undefined, reasoning: reasoning || undefined, toolCalls: [], stopReason: "error", error: "stream idle timeout", usage };

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
