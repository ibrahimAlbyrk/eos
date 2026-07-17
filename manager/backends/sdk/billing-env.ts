// Env for the SDK-spawned `claude` child (the claude-sdk backend drives the
// bundled claude binary as a subprocess; that child resolves billing auth from
// the env it receives). buildSubscriptionChildEnv strips the silent billing
// winners (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL) so they
// can't shadow the OAuth token, AND the parent CLAUDECODE / CLAUDE_CODE_* session
// markers — the SDK passes options.env through to the child verbatim, so leaking
// those makes it boot as a NESTED session (blank chat), the same failure the PTY
// lane guards against. Then inject the OAuth token (after the strip, so it wins),
// force direct tool loading (ENABLE_TOOL_SEARCH=false), and carry the EOS_* triplet.

import type { ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import { buildSubscriptionChildEnv } from "../../../core/src/domain/env-allowlist.ts";

export interface BillingGuardInput {
  readonly auth: ResolvedAuth;
  readonly workerId: string;
  readonly daemonUrl: string;
  /** Operator-configured Anthropic credentials (Settings > Anthropic). When set,
   *  they win over the ambient resolved token — see anthropicCredentialEnv. */
  readonly anthropic?: { apiKey?: string; authToken?: string };
}

// The ONE credential env var operator-set Anthropic creds contribute to the SDK
// child. Priority: authToken (the Max/Pro OAuth setup-token → CLAUDE_CODE_OAUTH_TOKEN)
// WINS over apiKey (the metered key → ANTHROPIC_API_KEY); with both set the API key
// is never emitted, so it can't shadow OAuth onto the metered pool. Blank /
// whitespace values count as unset. Only when authToken is absent does apiKey apply.
export function anthropicCredentialEnv(creds: { apiKey?: string; authToken?: string }): Record<string, string> {
  const authToken = creds.authToken?.trim();
  if (authToken) return { CLAUDE_CODE_OAUTH_TOKEN: authToken };
  const apiKey = creds.apiKey?.trim();
  if (apiKey) return { ANTHROPIC_API_KEY: apiKey };
  return {};
}

export function buildBillingGuardEnv(input: BillingGuardInput): Record<string, string> {
  return {
    ...buildSubscriptionChildEnv(process.env),
    ...(input.auth.scheme === "oauth" && input.auth.token ? { CLAUDE_CODE_OAUTH_TOKEN: input.auth.token } : {}),
    // Operator-configured creds win over the resolved token: a config authToken
    // overrides CLAUDE_CODE_OAUTH_TOKEN; a config apiKey re-introduces
    // ANTHROPIC_API_KEY (stripped above) and, being a billing winner, moves the
    // child onto the metered API. Spread AFTER the strip so the apiKey survives.
    ...anthropicCredentialEnv(input.anthropic ?? {}),
    ENABLE_TOOL_SEARCH: "false",
    EOS_SPAWNED: "1",
    EOS_WORKER_ID: input.workerId,
    EOS_DAEMON_URL: input.daemonUrl,
  };
}
