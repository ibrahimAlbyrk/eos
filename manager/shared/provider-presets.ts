// Built-in add-provider presets — the connection config (NOT the key) for the six
// OpenAI-compatible providers Eos ships ready to add. Each preset carries everything
// a BackendProfile needs except the API key: kind, origin-only baseUrl, the declared
// ProviderCapabilities (auth style + chat path quirks included), a sensible default
// model, the Keychain ref the key lands under, and a STATIC fallback model list the
// picker shows when a provider's live /v1/models is unreachable. So adding one is
// POST /api/backends { preset, apiKey } — nothing else. Pricing is NOT here: the
// auto-priced providers resolve via the LiteLLM catalog, and the manual ones (Qwen
// tiered, Zhipu flat) are built-in config.prices defaults (see shared/config.ts).
//
// Facts (base URLs, model IDs, capability quirks) are from model-research clusters
// 01–03; do not edit without re-checking those.

import type { BackendKind } from "../../contracts/src/canonical.ts";
import { ProviderCapabilitiesSchema, type ProviderCapabilities } from "../../contracts/src/provider-capabilities.ts";
import { normalizeBaseOrigin } from "../../infra/src/backends/base-url.ts";

export interface ProviderPreset {
  id: string;          // slug + config.backends key suggestion (e.g. "gemini")
  label: string;       // human label for a picker
  kind: BackendKind;
  baseUrl: string;     // origin-only; the client owns the chat/models path
  defaultModel: string;
  authRef: string;     // Keychain service id the key is stored under
  capabilities: ProviderCapabilities;
  fallbackModels: string[]; // flagship + key tiers, picker fallback when live list fails
}

// All six speak OpenAI Chat Completions; defaults fill the rest of the schema.
const caps = (over: Record<string, unknown>): ProviderCapabilities =>
  ProviderCapabilitiesSchema.parse({ wire: "openai-chat", ...over });

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com",
    defaultModel: "gpt-5.5",
    authRef: "eos-openai",
    capabilities: caps({
      reasoning: "openai-effort", reasoningRoundTrip: "none", cache: "automatic",
      contextWindow: 1_050_000, maxTokens: 128_000,
    }),
    fallbackModels: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "openai",
    // OpenAI-compat shim. Its path is /v1beta/openai/chat/completions (no extra
    // /v1), so chatCompletionsPath is /chat/completions onto this base. Native auth
    // is x-goog-api-key (the shim documents it; NOT Bearer).
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.1-pro-preview",
    authRef: "eos-gemini",
    capabilities: caps({
      reasoning: "none", reasoningRoundTrip: "none", cache: "automatic",
      contextWindow: 1_000_000, maxTokens: 64_000,
      authStyle: "x-goog-api-key", chatCompletionsPath: "/chat/completions",
    }),
    fallbackModels: ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai",
    defaultModel: "grok-4.3",
    authRef: "eos-xai",
    capabilities: caps({
      reasoning: "reasoning_content", reasoningRoundTrip: "drop", cache: "automatic",
      contextWindow: 1_000_000,
    }),
    fallbackModels: ["grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1"],
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    kind: "openai",
    // DashScope international (USD); compatible-mode/v1/chat/completions composes
    // from this origin + the default /v1 path.
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
    defaultModel: "qwen3.7-max",
    authRef: "eos-qwen",
    capabilities: caps({
      reasoning: "reasoning_content", reasoningRoundTrip: "drop", cache: "none",
      contextWindow: 1_000_000, maxTokens: 65_536,
    }),
    fallbackModels: ["qwen3.7-max", "qwen3.7-plus", "qwen3-coder-plus", "qwen3.6-flash"],
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    kind: "openai",
    baseUrl: "https://api.moonshot.ai",
    defaultModel: "kimi-k2.6",
    authRef: "eos-moonshot",
    capabilities: caps({
      reasoning: "reasoning_content", reasoningRoundTrip: "drop", cache: "automatic",
      contextWindow: 262_144,
    }),
    fallbackModels: ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.5"],
  },
  {
    id: "zhipu",
    label: "Zhipu GLM (Z.ai)",
    kind: "openai",
    // Z.ai's chat path is /api/paas/v4/chat/completions, NOT /v1/... — so baseUrl is
    // the bare origin and chatCompletionsPath carries the full path.
    baseUrl: "https://api.z.ai",
    defaultModel: "glm-5.2",
    authRef: "eos-zhipu",
    capabilities: caps({
      reasoning: "reasoning_content", reasoningRoundTrip: "drop", cache: "automatic",
      contextWindow: 200_000, maxTokens: 128_000,
      chatCompletionsPath: "/api/paas/v4/chat/completions",
    }),
    fallbackModels: ["glm-5.2", "glm-4.7", "glm-4.7-flash"],
  },
];

export function findPreset(id: string | undefined | null): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined;
}

// The static fallback model list for the provider whose origin matches `baseUrl`
// (both normalized so a stored "/v1"-stripped profile still matches). null when no
// preset owns that origin — the picker then falls back to just the pinned model.
export function fallbackModelsForBaseUrl(baseUrl: string | undefined | null): string[] | null {
  if (!baseUrl) return null;
  const origin = normalizeBaseOrigin(baseUrl);
  const hit = PROVIDER_PRESETS.find((p) => normalizeBaseOrigin(p.baseUrl) === origin);
  return hit ? hit.fallbackModels.slice() : null;
}
