// ProviderCapabilities — the per-provider quirks carried as DECLARED data on a
// BackendProfile (config), read by the two wire-dialect model clients instead of
// `if (model.startsWith("deepseek"))` heuristics. This is the same capability-not-
// kind discipline Eos already uses for AgentCapabilities/BackendDescriptor, extended
// to the in-process API lane: adding a provider stays config-only.
//
// Defaulted per kind so a bare profile (no capabilities block) still works; only
// `contextWindow` is consumed in M1 (the fail-fast context-window guard) — the rest
// are declared now and consumed by the M4 normalization/robustness work.

import { z } from "zod";

export const ProviderCapabilitiesSchema = z
  .object({
    // The wire dialect this provider speaks. Two dialects cover the whole
    // ecosystem (Anthropic Messages + OpenAI Chat Completions, baseUrl-swappable).
    wire: z.enum(["anthropic", "openai-chat"]),
    // How the API key is presented. "bearer" (the effective default when omitted —
    // applied in the model clients, NOT a schema .default(), so existing capability
    // literals stay valid) → `Authorization: Bearer <key>`. "x-goog-api-key" → the
    // key rides that header with NO Authorization (Gemini's native scheme; its
    // OpenAI-compat shim documents this header, not Bearer).
    authStyle: z.enum(["bearer", "x-goog-api-key"]).optional(),
    // The provider's chat-completions path RELATIVE TO baseUrl's origin (the client
    // owns it; baseUrl is origin-only). Omitted ⇒ "/v1/chat/completions". Set for a
    // provider whose path is not /v1/...: Zhipu ("/api/paas/v4/chat/completions"),
    // Gemini's shim ("/chat/completions", already under /v1beta/openai). The /models
    // path is derived from this (…/chat/completions → …/models).
    chatCompletionsPath: z.string().optional(),
    supportsStreaming: z.boolean().default(true),
    supportsTools: z.boolean().default(true),
    supportsParallelToolCalls: z.boolean().default(true),
    // How the provider exposes reasoning, and whether reasoning must be echoed
    // back across tool turns (the #1 cross-provider hazard — opposite for
    // Anthropic vs DeepSeek). Consumed in M4.
    reasoning: z.enum(["none", "openai-effort", "anthropic-thinking", "reasoning_content"]).default("none"),
    reasoningRoundTrip: z.enum(["drop", "preserve-signed", "none"]).default("drop"),
    cache: z.enum(["none", "anthropic-explicit", "automatic"]).default("automatic"),
    cacheMinTokens: z.number().int().nonnegative().optional(),
    structuredOutput: z
      .enum(["none", "openai-response_format", "anthropic-output_config", "vllm-guided_json", "ollama-format"])
      .default("none"),
    // The model's context window (tokens). Consumed in M1 by the fail-fast
    // pre-flight guard, and in M4 by the ContextCompactor (drop-oldest near the
    // window) so a small-context model compacts instead of a raw 400.
    contextWindow: z.number().int().positive(),
    // Max ms the streaming parser will wait for the NEXT chunk before treating the
    // stream as stalled (resolves stopReason:"error" instead of hanging the turn) —
    // an endpoint that holds the socket open after sending its data (or never sends
    // [DONE]) can otherwise wedge the whole turn. Capability-gated but defaulted in
    // the client, so omitting it keeps the safe default — never a per-kind branch.
    streamIdleTimeoutMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    // The request parameter carrying the output-token cap. Chat Completions took
    // `max_tokens` originally; OpenAI's gpt-5.x reasoning models on /v1/chat/completions
    // REJECT it and require `max_completion_tokens`. Declared per-provider so the client
    // emits the right key — default keeps every existing provider on `max_tokens`.
    maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
    // OpenAI's gpt-5.x on /v1/chat/completions returns 400 when `reasoning_effort` is
    // sent together with function tools. When true, the client omits reasoning_effort
    // ONLY on requests that attach tools (a text-only turn still gets it). Default false
    // → no provider suppresses, so effort emission is unchanged everywhere else.
    dropReasoningEffortWithTools: z.boolean().default(false),
    // Bounded exponential-backoff knobs for the shared withRetry wrapper inside the
    // two model clients (M4): retry 429/5xx honoring Retry-After. Capability-gated
    // (a per-provider override) but defaulted in the client, so omitting it keeps
    // the safe defaults — never a per-provider branch.
    retry: z
      .object({
        maxRetries: z.number().int().nonnegative().optional(),
        baseMs: z.number().int().positive().optional(),
        capMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
