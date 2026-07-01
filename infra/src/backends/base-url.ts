// baseUrl is an ORIGIN ONLY (scheme+host[+port]) by convention (MJ1) — the model
// client owns the version + path (/v1/...). Defensively normalize a configured
// baseUrl so a user-supplied trailing slash or trailing "/v1" never double-joins
// into "/v1/v1/..." (e.g. "http://localhost:11434/v1" → "/v1/v1/chat/completions"
// 404). Strip trailing slashes first, then a single trailing "/v1".
export function normalizeBaseOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// The chat-completions path the OpenAI-compat client appends to baseUrl when a
// provider declares none. Capability `chatCompletionsPath` overrides it.
export const DEFAULT_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

// Derive a provider's /models listing path from its chat-completions path: the two
// sit beside each other (".../chat/completions" ↔ ".../models"), so swap the tail.
// Falls back to "/v1/models" for any path that isn't ".../chat/completions".
export function modelsPathFor(chatCompletionsPath: string | undefined): string {
  const p = chatCompletionsPath ?? DEFAULT_CHAT_COMPLETIONS_PATH;
  return p.endsWith("/chat/completions") ? `${p.slice(0, -"/chat/completions".length)}/models` : "/v1/models";
}
