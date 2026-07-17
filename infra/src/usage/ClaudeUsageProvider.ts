// ClaudeUsageProvider — the Max/Pro subscription usage adapter. Hits the same
// undocumented OAuth usage endpoint the Claude CLI uses and maps the response
// onto the provider-neutral ProviderUsage read model.
//
// Auth is INJECTED as a SUPPLIER of ordered candidate tokens (getTokens) — the
// adapter never reads the Keychain itself, so the token-resolution chain (config
// override → Keychain → env) stays at the composition root. The adapter WALKS the
// candidates: a source whose token is rejected for auth/scope reasons (HTTP 401/403,
// e.g. the `user:profile` scope requirement) is skipped in favour of the next, and
// the source that worked is remembered so the next fetch tries it first (re-walking
// from the top only when it later fails). Tokens are bearer-only; never logged or
// returned.
//
// EMPIRICAL FINDING (verified by a live curl): `utilization` on this endpoint is
// already on a 0–100 scale (e.g. five_hour 41.0, seven_day 59.0), NOT 0–1. So the
// adapter CLAMPS to [0,100] rather than rescaling — applying a "×100 if ≤1"
// heuristic would corrupt a genuine sub-1% reading.

import type { SubscriptionUsageProvider } from "../../../core/src/ports/SubscriptionUsageProvider.ts";
import type { ProviderUsage, UsageWindow } from "../../../contracts/src/usage.ts";
import { errMsg } from "../../../contracts/src/util.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// The User-Agent is load-bearing: without a `claude-code/*` product token the
// request lands in an aggressively-throttled bucket. Only the product prefix
// matters for bucket routing, so a slightly stale version is harmless; kept
// overridable for tests.
const DEFAULT_USER_AGENT = "claude-code/2.1.212";

// Distinguishes "no token configured" (a quiet UI hint pointing at Settings ›
// Anthropic) from a real upstream/scope failure (an error). The UI matches on
// the "subscription token" phrase; the scope error says "OAuth token" instead.
export const NO_TOKEN_REASON = "No Claude subscription token configured.";

type FetchFn = typeof fetch;

// One candidate OAuth token plus a stable label for the source it came from
// (e.g. "config", "keychain", "env"). The label is used only to remember which
// source worked and to tag aggregated errors — never the token itself.
export interface UsageTokenCandidate {
  source: string;
  token: string;
}

export interface ClaudeUsageProviderDeps {
  /** Supply the ordered candidate tokens, highest precedence first (config
   *  override → Keychain → env). Empty when no subscription credential is present. */
  getTokens: () => Promise<UsageTokenCandidate[]> | UsageTokenCandidate[];
  fetchImpl?: FetchFn;
  userAgent?: string;
  /** Injectable clock for the snapshot timestamp (tests pin it). */
  now?: () => Date;
}

// Outcome of a single candidate attempt. `rejected` marks an auth/scope failure
// (HTTP 401/403) where a DIFFERENT source could still succeed → the walk advances.
// Any other failure (429, 5xx, network) is token-independent → the walk stops and
// throws, preserving the upstream signal (e.g. the 429 the endpoint throttles with).
type AttemptResult =
  | { ok: true; usage: ProviderUsage }
  | { ok: false; rejected: boolean; error: Error };

function clampUtilization(u: number): number {
  if (!Number.isFinite(u)) return 0;
  return Math.max(0, Math.min(100, u));
}

// A window is emitted only when the source carries both a numeric utilization and
// an ISO resets_at; anything else (null slot, missing fields) becomes null.
function toWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const resetsAt = r.resets_at;
  if (typeof r.utilization !== "number" || typeof resetsAt !== "string") return null;
  return { utilization: clampUtilization(r.utilization), resetsAt };
}

function toExtraUsage(raw: unknown): ProviderUsage["extraUsage"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    isEnabled: r.is_enabled === true,
    usedCredits: typeof r.used_credits === "number" ? r.used_credits : null,
    monthlyLimit: typeof r.monthly_limit === "number" ? r.monthly_limit : null,
  };
}

export function createClaudeUsageProvider(deps: ClaudeUsageProviderDeps): SubscriptionUsageProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const now = deps.now ?? (() => new Date());

  // The source that last succeeded — tried first on the next fetch. Cleared on any
  // failure so the following fetch re-walks the full chain from the top.
  let preferredSource: string | null = null;

  function toSnapshot(data: Record<string, unknown>): ProviderUsage {
    return {
      provider: "claude",
      windows: {
        fiveHour: toWindow(data.five_hour),
        sevenDay: toWindow(data.seven_day),
        sevenDayOpus: toWindow(data.seven_day_opus),
        sevenDaySonnet: toWindow(data.seven_day_sonnet),
      },
      extraUsage: toExtraUsage(data.extra_usage),
      fetchedAt: now().toISOString(),
    };
  }

  async function attempt(token: string): Promise<AttemptResult> {
    let res: Response;
    try {
      res = await fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
      });
    } catch (e) {
      return { ok: false, rejected: false, error: new Error(`usage request failed: ${errMsg(e)}`, { cause: e }) };
    }

    if (!res.ok) {
      // Surface the upstream message (scope requirement, 429, …) verbatim but
      // capped — the UsageService routes it into errors[], never a crash.
      const body = await res.text().catch(() => "");
      const detail = body ? `: ${body.slice(0, 300)}` : "";
      // 401/403 mean THIS credential was rejected (bad/expired token, or the
      // `user:profile` scope requirement) — a different source may still work.
      const rejected = res.status === 401 || res.status === 403;
      return { ok: false, rejected, error: new Error(`usage fetch failed (HTTP ${res.status})${detail}`) };
    }

    return { ok: true, usage: toSnapshot((await res.json()) as Record<string, unknown>) };
  }

  return {
    id: "claude",
    async fetchUsage(): Promise<ProviderUsage> {
      const candidates = await deps.getTokens();
      if (!candidates.length) throw new Error(NO_TOKEN_REASON);

      // Try the remembered working source first, then the rest in precedence order.
      const ordered = preferredSource
        ? [...candidates].sort((a, b) =>
            a.source === preferredSource ? -1 : b.source === preferredSource ? 1 : 0,
          )
        : candidates;

      let lastRejection: Error | null = null;
      for (const c of ordered) {
        const r = await attempt(c.token);
        if (r.ok) {
          preferredSource = c.source;
          return r.usage;
        }
        // Token-independent failure (429/5xx/network): stop and surface it — a
        // different source would fail the same way and re-requesting hammers the
        // throttled endpoint.
        if (!r.rejected) {
          preferredSource = null;
          throw r.error;
        }
        lastRejection = r.error;
      }

      // Every candidate's token was rejected — surface the last rejection (it
      // carries the scope-requirement body the UI maps to a friendly message).
      preferredSource = null;
      throw lastRejection ?? new Error(NO_TOKEN_REASON);
    },
  };
}
