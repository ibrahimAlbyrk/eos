// Is a Claude OAuth token still accepted? One cheap authenticated read — GET
// /v1/models, the inference-scope call the model catalog already makes, so a
// setup-token (inference scope only) passes it. Only a 401 means "rejected"
// (expired or revoked); anything else — network, 429, 5xx — is "unknown", so a
// flaky connection never shows a signed-in user as expired. The token is sent
// as a bearer header and never logged.

export type TokenProbeResult = "valid" | "rejected" | "unknown";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const PROBE_TIMEOUT_MS = 8_000;

export async function probeClaudeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<TokenProbeResult> {
  try {
    const res = await fetchImpl(MODELS_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401) return "rejected";
    return res.ok ? "valid" : "unknown";
  } catch {
    return "unknown";
  }
}
