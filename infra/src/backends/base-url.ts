// baseUrl is an ORIGIN ONLY (scheme+host[+port]) by convention (MJ1) — the model
// client owns the version + path (/v1/...). Defensively normalize a configured
// baseUrl so a user-supplied trailing slash or trailing "/v1" never double-joins
// into "/v1/v1/..." (e.g. "http://localhost:11434/v1" → "/v1/v1/chat/completions"
// 404). Strip trailing slashes first, then a single trailing "/v1".
export function normalizeBaseOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
