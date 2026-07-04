// withRetry — a shared bounded exponential-backoff wrapper used INSIDE both model
// clients (Anthropic + OpenAI). A single sustained 429/5xx used to kill a metered
// turn (the client returned stopReason:"error" on the first !resp.ok). This retries
// the retryable statuses, honoring Retry-After, then hands the final response back
// to the client — which still maps a non-retryable status / exhausted retries to
// stopReason:"error". NOT a per-provider branch: the knobs are capability-gated
// (ProviderCapabilities.retry) but defaulted here, so any provider gets safe retry.

export interface RetryPolicy {
  maxRetries: number;
  baseMs: number;
  capMs: number;
}

// 429 = rate limit; 500/502/503 = transient server; 529 = Anthropic "overloaded".
// A non-retryable status (400/401/403/404/…) falls straight through to the client's
// !resp.ok error mapping. 408 (request timeout) is treated as retryable too.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529]);

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 4, baseMs: 500, capMs: 30_000 };

export function resolveRetryPolicy(over?: { maxRetries?: number; baseMs?: number; capMs?: number }): RetryPolicy {
  return {
    maxRetries: over?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
    baseMs: over?.baseMs ?? DEFAULT_RETRY_POLICY.baseMs,
    capMs: over?.capMs ?? DEFAULT_RETRY_POLICY.capMs,
  };
}

export type SleepFn = (ms: number) => Promise<void>;
export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse a Retry-After header (delta-seconds OR an HTTP-date) into milliseconds, or
// null when absent/unparseable. Defensive against fakes with no headers object.
function retryAfterMs(resp: Response): number | null {
  const h = resp.headers?.get?.bind(resp.headers);
  const raw = h ? h("retry-after") : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Free the previous response's socket before retrying (a retried body is never read).
async function discard(resp: Response): Promise<void> {
  try {
    if (resp.body) await resp.body.cancel();
    else if (typeof resp.text === "function") await resp.text();
  } catch {
    /* best-effort */
  }
}

// A thrown fetch is the transport:"network" class the clients already report (undici
// "fetch failed", connection reset/refused, DNS, timeout) — transient, so retry it.
// The ONE exception that must fail fast: an abort. A cancelled turn flips signal.aborted;
// a fetch tied to a real AbortSignal throws an AbortError. Retrying a cancel is a bug,
// so both short-circuit. (Auth throws / request-construction errors never reach here:
// auth surfaces as a non-OK Response, and the body is built before doFetch runs.)
function isAbort(e: unknown, signal?: { aborted: boolean }): boolean {
  if (signal?.aborted) return true;
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

// Run doFetch, retrying with bounded exponential backoff. Two retryable failures share
// ONE policy: a retryable HTTP status (Retry-After wins when present, clamped to capMs)
// and a thrown transient network error (backoff only — no response to read a header from).
// A non-retryable status falls through to the client's !resp.ok mapping; an exhausted or
// aborted throw re-propagates so the client maps it to a typed provider error.
export async function withRetry(
  doFetch: () => Promise<Response>,
  policy: RetryPolicy,
  sleep: SleepFn = defaultSleep,
  signal?: { aborted: boolean },
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let resp: Response;
    try {
      resp = await doFetch();
    } catch (e) {
      if (isAbort(e, signal) || attempt >= policy.maxRetries) throw e;
      await sleep(Math.min(policy.capMs, policy.baseMs * 2 ** attempt));
      attempt++;
      continue;
    }
    if (!RETRYABLE_STATUS.has(resp.status) || attempt >= policy.maxRetries) return resp;
    if (signal?.aborted) return resp;
    const ra = retryAfterMs(resp);
    const backoff = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
    await discard(resp);
    await sleep(Math.min(policy.capMs, ra ?? backoff));
    attempt++;
  }
}
