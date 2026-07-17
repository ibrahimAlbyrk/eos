import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClaudeUsageProvider, NO_TOKEN_REASON } from "../usage/ClaudeUsageProvider.ts";
import type { UsageTokenCandidate } from "../usage/ClaudeUsageProvider.ts";

// The live shape (trimmed) confirmed by a real curl of the endpoint.
const LIVE_BODY = {
  five_hour: { utilization: 41.0, resets_at: "2026-07-17T22:50:00+00:00" },
  seven_day: { utilization: 59.0, resets_at: "2026-07-21T06:00:00+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12.0, resets_at: "2026-07-21T06:00:00+00:00" },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0.0, utilization: null },
};

const SCOPE_BODY =
  '{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; text?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    async json() { return body; },
    async text() { return init?.text ?? JSON.stringify(body); },
  } as unknown as Response;
}

// A fetchImpl that dispatches by the Bearer token, recording the tokens it saw so a
// test can assert the walk order + that a rejected/short-circuited source is skipped.
function tokenRouter(routes: Record<string, () => Response>, seen: string[]): typeof fetch {
  return (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const auth = (init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    seen.push(auth);
    const r = routes[auth];
    if (!r) throw new Error(`unexpected token ${auth}`);
    return r();
  }) as unknown as typeof fetch;
}

const cand = (source: string, token: string): UsageTokenCandidate => ({ source, token });

describe("ClaudeUsageProvider", () => {
  it("maps the live response and keeps utilization on a 0–100 scale", async () => {
    const provider = createClaudeUsageProvider({
      getTokens: () => [cand("keychain", "tok")],
      fetchImpl: async () => jsonResponse(LIVE_BODY),
      now: () => new Date("2026-07-17T20:00:00Z"),
    });
    const usage = await provider.fetchUsage();
    assert.equal(usage.provider, "claude");
    assert.equal(usage.windows.fiveHour?.utilization, 41);
    assert.equal(usage.windows.sevenDay?.utilization, 59);
    assert.equal(usage.windows.sevenDayOpus, null); // null slot stays null
    assert.equal(usage.windows.sevenDaySonnet?.utilization, 12);
    assert.equal(usage.extraUsage?.isEnabled, false);
    assert.equal(usage.extraUsage?.usedCredits, 0);
    assert.equal(usage.extraUsage?.monthlyLimit, null);
    assert.equal(usage.fetchedAt, "2026-07-17T20:00:00.000Z");
  });

  it("sends the load-bearing claude-code User-Agent + oauth beta headers", async () => {
    let seen: Record<string, string> | undefined;
    const provider = createClaudeUsageProvider({
      getTokens: () => [cand("keychain", "tok-123")],
      userAgent: "claude-code/9.9.9",
      fetchImpl: async (_url, init) => { seen = init?.headers as Record<string, string>; return jsonResponse(LIVE_BODY); },
    });
    await provider.fetchUsage();
    assert.equal(seen?.["User-Agent"], "claude-code/9.9.9");
    assert.equal(seen?.["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(seen?.Authorization, "Bearer tok-123");
  });

  it("throws the no-token reason when no candidate is supplied", async () => {
    const provider = createClaudeUsageProvider({ getTokens: () => [], fetchImpl: async () => jsonResponse({}) });
    await assert.rejects(() => provider.fetchUsage(), (e: Error) => e.message === NO_TOKEN_REASON);
  });

  it("advances past a source whose token lacks the user:profile scope (403) to the next", async () => {
    const seen: string[] = [];
    const provider = createClaudeUsageProvider({
      getTokens: () => [cand("config", "bad"), cand("keychain", "good")],
      fetchImpl: tokenRouter(
        {
          bad: () => jsonResponse(null, { ok: false, status: 403, text: SCOPE_BODY }),
          good: () => jsonResponse(LIVE_BODY),
        },
        seen,
      ),
    });
    const usage = await provider.fetchUsage();
    assert.equal(usage.windows.fiveHour?.utilization, 41);
    assert.deepEqual(seen, ["bad", "good"]); // config tried first, then fell back
  });

  it("remembers the working source and tries it first on the next fetch", async () => {
    const seen: string[] = [];
    const provider = createClaudeUsageProvider({
      getTokens: () => [cand("config", "bad"), cand("keychain", "good")],
      fetchImpl: tokenRouter(
        {
          bad: () => jsonResponse(null, { ok: false, status: 403, text: SCOPE_BODY }),
          good: () => jsonResponse(LIVE_BODY),
        },
        seen,
      ),
    });
    await provider.fetchUsage();
    await provider.fetchUsage();
    // First walk: bad → good. Second fetch tries the remembered "good" first and stops.
    assert.deepEqual(seen, ["bad", "good", "good"]);
  });

  it("surfaces the scope error when every source is rejected (all 403)", async () => {
    const seen: string[] = [];
    const provider = createClaudeUsageProvider({
      getTokens: () => [cand("config", "bad1"), cand("keychain", "bad2")],
      fetchImpl: tokenRouter(
        {
          bad1: () => jsonResponse(null, { ok: false, status: 403, text: SCOPE_BODY }),
          bad2: () => jsonResponse(null, { ok: false, status: 403, text: SCOPE_BODY }),
        },
        seen,
      ),
    });
    await assert.rejects(() => provider.fetchUsage(), /HTTP 403.*scope requirement user:profile/);
    assert.deepEqual(seen, ["bad1", "bad2"]); // both attempted before failing
  });

  it("stops on a token-independent error (429) without trying further sources", async () => {
    const seen: string[] = [];
    const provider = createClaudeUsageProvider({
      getTokens: () => [cand("config", "throttled"), cand("keychain", "good")],
      fetchImpl: tokenRouter(
        {
          throttled: () => jsonResponse(null, { ok: false, status: 429, text: "rate limited" }),
          good: () => jsonResponse(LIVE_BODY),
        },
        seen,
      ),
    });
    await assert.rejects(() => provider.fetchUsage(), /HTTP 429/);
    assert.deepEqual(seen, ["throttled"]); // 429 is not a scope error → no fallback hammering
  });
});
