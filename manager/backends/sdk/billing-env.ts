// Env for the SDK-spawned `claude` child (the claude backend drives the
// bundled claude binary as a subprocess; that child resolves billing auth from
// the env it receives). buildSubscriptionChildEnv strips the silent billing
// winners (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL) so they
// can't shadow the OAuth token, AND the parent CLAUDECODE / CLAUDE_CODE_* session
// markers — the SDK passes options.env through to the child verbatim, so leaking
// those makes it boot as a NESTED session (blank chat), the same failure the PTY
// lane guards against. Then inject the ONE credential the Accounts rule picks
// (after the strip, so it wins), force direct tool loading (ENABLE_TOOL_SEARCH=false), and carry the EOS_* triplet.

import type { ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import { buildSubscriptionChildEnv } from "../../../core/src/domain/env-allowlist.ts";
import { resolveBillingRoute } from "../../../core/src/domain/billing-route.ts";
import { CLAUDE_STORE_ENV } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";

export interface BillingGuardInput {
  readonly auth: ResolvedAuth;
  readonly workerId: string;
  readonly daemonUrl: string;
  /** Operator-configured Anthropic credentials (Settings › Accounts). The token
   *  wins over the ambient resolved one; the key applies only with no subscription
   *  at all — see anthropicCredentialEnv. */
  readonly anthropic?: { apiKey?: string; authToken?: string };
  /** Eos compaction is on → switch off the binary's own silent auto-compaction
   *  (DISABLE_AUTO_COMPACT also covers its prompt-too-long retry), so the only
   *  compaction is the visible one. Manual native /compact stays available. */
  readonly disableAutoCompact?: boolean;
  /** Eos's claude credential store: the only login the child may read, so a
   *  Claude Code login elsewhere on the Mac never bills. */
  readonly claudeStore?: string;
  /** A focused session: the binary's own defaults, like a terminal session —
   *  the Artifact tool on (the binary turns it off for SDK sessions) and tool
   *  search left on (MCP tools load on demand). */
  readonly fullSurface?: boolean;
}

// The ONE credential env var the SDK child gets, per the Accounts rule
// (core/domain/billing-route): any subscription — the operator's Eos sign-in
// (config authToken) or the resolved Claude login — wins, and the API key is then
// never exported, so it can't shadow OAuth onto the metered pool. A resolved oauth
// with no token is a refreshable login: nothing is exported and the child reads its
// own store. The key applies only when no subscription exists at all. Blank /
// whitespace values count as unset.
export function anthropicCredentialEnv(
  creds: { apiKey?: string; authToken?: string },
  auth: ResolvedAuth = { scheme: "none" },
): Record<string, string> {
  const configToken = creds.authToken?.trim();
  const signedIn = Boolean(configToken) || auth.scheme === "oauth";
  const apiKey = creds.apiKey?.trim();
  const route = resolveBillingRoute(signedIn ? "signed_in" : "signed_out", Boolean(apiKey));
  if (route === "subscription") {
    const token = configToken || auth.token;
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
  }
  return route === "api_key" && apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};
}

// Whether a claude session has ANY credential to run on — a resolved login or an
// operator-set token/key. Callers that must not spawn blind (summarizer, judge)
// check this instead of the resolver alone, so an Eos-only sign-in counts.
export function hasClaudeCredential(creds: { apiKey?: string; authToken?: string }, auth: ResolvedAuth): boolean {
  return auth.scheme !== "none" || Object.keys(anthropicCredentialEnv(creds, auth)).length > 0;
}

export function buildBillingGuardEnv(input: BillingGuardInput): Record<string, string> {
  return {
    ...buildSubscriptionChildEnv(process.env),
    // Spread AFTER the strip so an operator-set apiKey survives it.
    ...anthropicCredentialEnv(input.anthropic ?? {}, input.auth),
    ...(input.claudeStore ? { [CLAUDE_STORE_ENV]: input.claudeStore } : {}),
    ...(input.fullSurface ? { CLAUDE_CODE_ARTIFACT: "1" } : { ENABLE_TOOL_SEARCH: "false" }),
    ...(input.disableAutoCompact ? { DISABLE_AUTO_COMPACT: "1" } : {}),
    EOS_SPAWNED: "1",
    EOS_WORKER_ID: input.workerId,
    EOS_DAEMON_URL: input.daemonUrl,
  };
}
