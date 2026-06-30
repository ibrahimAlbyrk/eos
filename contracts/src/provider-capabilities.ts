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
    maxTokens: z.number().int().positive().optional(),
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
